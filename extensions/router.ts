/**
 * router/auto - a virtual model that classifies the first user message once, then stays on the
 * chosen model for the rest of the session so the prompt cache is never invalidated by routing.
 *
 * Classifier backend (swap with one env var, no code change):
 *   PI_ROUTER_CLASSIFIER=laya (default)  local laya-serve, which speaks Jev's System One protocol
 *   PI_ROUTER_CLASSIFIER=jev             TypeSafe Jev (needs TYPESAFE_API_KEY)
 *   LAYA_URL                             laya-serve base URL (default http://127.0.0.1:8000/v1)
 *
 * Laya reuses pi's built-in TypeSafe System One client by pointing the `typesafe` provider at
 * laya-serve, so the footer and /session show the classifier as typesafe/jev-latest either way.
 *
 * When the classifier is unavailable, the session falls back to FALLBACK_TIER and says so once.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

// Tier -> physical model. Role split follows oh-my-openagent's agent-model-matching guide.
const TIERS = {
	standard: { provider: "anthropic", id: "claude-sonnet-5-5", criteria: "Ordinary features, fixes, reviews, docs, or questions" },
	complex: { provider: "anthropic", id: "claude-opus-5-5", criteria: "Subtle design, cross-cutting refactors, or hard debugging" },
	deep: { provider: "openai", id: "gpt-6.1-sol", criteria: "Logic-heavy algorithms, backend internals, or math with a clear goal" },
} as const;
type Tier = keyof typeof TIERS;
const FALLBACK_TIER: Tier = "complex";

// Laya's per-request state limit is 50k chars; the opening request is what decides the tier.
const MAX_PROMPT_CHARS = 16_000;
// ponytail: fixed threshold; below it the answer is a near-tie (seen: 0.363 vs 0.359), so take
// FALLBACK_TIER rather than risk routing hard work down. Tune from logged probabilities if needed.
const MIN_PROBABILITY = 0.5;

interface RouterState {
	tier: Tier;
}

function firstUserText(messages: readonly Message[]): string {
	const content = messages.find((message) => message.role === "user")?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

async function classifyTier(request: ModelRouteRequest<RouterState>, ctx: ExtensionContext): Promise<Tier | undefined> {
	const classifier = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
	if (!classifier) return undefined;
	try {
		const result = await ctx.modelRegistry.classify(
			classifier,
			{
				state: { prompt: firstUserText(request.messages).slice(0, MAX_PROMPT_CHARS) },
				questions: {
					tier: {
						type: "choice",
						instructions: "Which kind of software engineering work does `prompt` request?",
						criteria: Object.fromEntries(Object.entries(TIERS).map(([tier, t]) => [tier, t.criteria])),
					},
				},
			},
			{ signal: request.signal },
		);
		const answer = result.stopReason === "stop" ? result.answers.tier : undefined;
		if (answer?.type !== "choice" || !(answer.choice in TIERS)) return undefined;
		return (answer.probabilities[answer.choice] ?? 0) >= MIN_PROBABILITY ? (answer.choice as Tier) : FALLBACK_TIER;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	if ((process.env.PI_ROUTER_CLASSIFIER ?? "laya") === "laya") {
		pi.registerProvider("typesafe", {
			baseUrl: process.env.LAYA_URL ?? "http://127.0.0.1:8000/v1",
			apiKey: "laya-local",
		});
	}

	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: "auto",
		name: "Auto (classified once)",
		thinkingLevels: ["low", "medium", "high", "xhigh"],
		// Smallest window among the tiers; Pi uses the routed model's real limits after the first response.
		contextWindow: 272_000,
		maxTokens: 128_000,
		async route(request, ctx) {
			// Direct requests (compaction summaries) carry no state; keep them on the session's model.
			if (request.reason === "direct" && request.previous) {
				return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel };
			}
			let state = request.state;
			if (!state) {
				const tier = await classifyTier(request, ctx);
				// Throwing ends this request without storing a tier, so a cancelled classification is retried next time.
				request.signal?.throwIfAborted();
				if (!tier && ctx.hasUI) {
					ctx.ui.notify(`router/auto: classifier unavailable, using ${FALLBACK_TIER}`, "warning");
				}
				state = { tier: tier ?? FALLBACK_TIER };
			}
			const { provider, id } = TIERS[state.tier];
			const model = ctx.modelRegistry.find(provider, id);
			if (!model) throw new Error(`router/auto: ${provider}/${id} is not in the model catalog`);
			// Returning the same state object keeps it; a new object is stored once, on the first request.
			return { model, thinkingLevel: request.thinkingLevel, state };
		},
	});
}
