/**
 * router/auto - a virtual model that classifies the first user message once, then stays on the
 * chosen model for the rest of the session so the prompt cache is never invalidated by routing.
 * The one exception is a quick (question-only) session, which classifies each new user message
 * until one needs more than Sonnet.
 * The same classification sets the thinking level, until the user picks another one in pi.
 *
 * Classifier backend (swap with one env var, no code change):
 *   PI_ROUTER_CLASSIFIER=laya (default)  local laya-serve, which speaks Jev's System One protocol
 *   PI_ROUTER_CLASSIFIER=jev             TypeSafe Jev (needs TYPESAFE_API_KEY)
 *   LAYA_URL                             laya-serve base URL (default http://127.0.0.1:8000/v1)
 *   LAYA_SERVE_BIN                       laya-serve executable pi starts (default `laya-serve` on PATH)
 *
 * Laya reuses pi's built-in TypeSafe System One client by pointing the `typesafe` provider at
 * laya-serve, so the footer and /session show the classifier as typesafe/jev-latest either way.
 *
 * When the classifier is unavailable, the session falls back to FALLBACK_TIER and says so once.
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { PLAN_FIRST } from "./handoff.ts";
import { createLaya } from "./laya.ts";

export { spawnWithLifeline } from "./laya.ts";

// Tier -> physical model. Opus is the default; deep work, and complex work Laya rates xhigh, run on Fable
// at medium thinking; questions that change no code run on Sonnet at medium. GPT stays in subagents
// (deep-worker, reviewers).
// Claude goes through pi-claude-cli (the logged-in `claude` CLI) so it draws on subscription limits, not extra usage.
// An id ending in `-*` means the newest version of that family the provider lists (see resolveModel).
// ponytail: a Fable session stays on Fable for good; point deep and complex-high at Opus if Fable's allowance runs short.
const TIERS = {
	// Not sticky: a Q&A opener often turns into work, so each new user message is classified again until
	// another tier wins. Moving to Opus costs one cache miss, which a short Q&A history makes cheap.
	quick: { provider: "pi-claude-cli", id: "claude-sonnet-*", criteria: "A question, explanation, or greeting that asks for no code change", thinking: "medium" },
	standard: { provider: "pi-claude-cli", id: "claude-opus-*", criteria: "Ordinary features, fixes, reviews, or docs" },
	complex: { provider: "pi-claude-cli", id: "claude-opus-*", criteria: "Subtle design, cross-cutting refactors, or hard debugging", xhigh: "complex-high" },
	deep: { provider: "pi-claude-cli", id: "claude-fable-*", criteria: "Logic-heavy algorithms, backend internals, or math with a clear goal", thinking: "medium" },
	// Not offered to Laya: reached only through complex's `xhigh`, and run at medium thinking.
	"complex-high": { provider: "pi-claude-cli", id: "claude-fable-*", thinking: "medium" },
} as const;
type Tier = keyof typeof TIERS;
const FALLBACK_TIER: Tier = "complex";

// Laya scores the opening request 0-3 against these levels; the last level whose `from` the score
// reaches picks the thinking level. Its scores bunch below 2.5 (hardest seen: 2.43), so xhigh starts at
// 2.15, the best cut on 24 labelled prompts (19 right, against 15 with plain rounding).
// ponytail: cut fitted to a small sample, and short how-to questions still rate high (seen: 1.61);
// refit from logged scores if xhigh escalates too often. xhigh itself only reaches a standard session,
// since deep and complex-high run on Fable at medium.
const EFFORTS = [
	{ level: "low", from: 0, criteria: "Trivial: a typo, a rename, a one-line change, or explaining a command or concept" },
	{ level: "medium", from: 0.5, criteria: "Routine: an ordinary feature, fix, test, or review with a clear path" },
	{ level: "high", from: 1.5, criteria: "Hard: careful reasoning across several steps, files, or design tradeoffs" },
	{ level: "xhigh", from: 2.15, criteria: "Very hard: subtle concurrency or correctness bugs, novel algorithms, or high-stakes design" },
] as const;

// Laya's per-request state limit is 50k chars; the opening request is what decides the tier.
const MAX_PROMPT_CHARS = 16_000;
// ponytail: fixed threshold; below it the answer is a near-tie (seen: 0.363 vs 0.359), so take
// FALLBACK_TIER rather than risk routing hard work down. Tune from logged probabilities if needed.
const MIN_PROBABILITY = 0.5;

interface RouterState {
	tier: Tier;
	// The classifier could not answer, so `tier` is FALLBACK_TIER by default rather than by choice.
	unclassified?: true;
	// Laya's probability for its top choice; below MIN_PROBABILITY, `tier` is FALLBACK_TIER instead.
	probability?: number;
	// Thinking level Laya chose, and the user's level at the time; picking another level in pi drops it.
	effort?: ModelRouteRequest["thinkingLevel"];
	userLevel?: ModelRouteRequest["thinkingLevel"];
	// Laya's raw answers, for the dataset log: every tier's probability and the 0-3 effort score.
	probabilities?: Record<string, number>;
	score?: number;
}

// The latest user message: the first one for a new session, the new one when a quick session reclassifies.
// handoff's plan-first note reaches the router as a user message after the real one; skip it.
function latestUserText(messages: readonly Message[]): string {
	const text = (content: Message["content"]) =>
		typeof content === "string" ? content : content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const texts = messages.flatMap((message) => (message.role === "user" ? [text(message.content)] : []));
	return texts.findLast((t) => t !== PLAN_FIRST) ?? "";
}

async function classifyRequest(request: ModelRouteRequest<RouterState>, ctx: ExtensionContext): Promise<RouterState | undefined> {
	const classifier = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
	if (!classifier) return undefined;
	try {
		const result = await ctx.modelRegistry.classify(
			classifier,
			{
				state: { prompt: latestUserText(request.messages).slice(0, MAX_PROMPT_CHARS) },
				questions: {
					tier: {
						type: "choice",
						instructions: "Which kind of software engineering work does `prompt` request?",
						criteria: Object.fromEntries(Object.entries(TIERS).flatMap(([tier, t]) => ("criteria" in t ? [[tier, t.criteria]] : []))),
					},
					effort: {
						type: "score",
						instructions: "How much reasoning does the software engineering request in `prompt` need?",
						criteria: EFFORTS.map((e) => e.criteria),
					},
				},
			},
			{ signal: request.signal },
		);
		const answer = result.stopReason === "stop" ? result.answers.tier : undefined;
		if (answer?.type !== "choice" || !(answer.choice in TIERS)) return undefined;
		const probability = answer.probabilities[answer.choice] ?? 0;
		const chosen = probability >= MIN_PROBABILITY ? (answer.choice as Tier) : FALLBACK_TIER;
		const score = result.answers.effort;
		const effort = score?.type === "score" ? EFFORTS.findLast((e) => score.score >= e.from)?.level : undefined;
		const t = TIERS[chosen];
		const tier = effort === "xhigh" && "xhigh" in t ? t.xhigh : chosen;
		const routed = TIERS[tier];
		const raw = { probability, probabilities: answer.probabilities, score: score?.type === "score" ? score.score : undefined };
		return effort ? { tier, ...raw, effort: "thinking" in routed ? routed.thinking : effort, userLevel: request.thinkingLevel } : { tier, ...raw };
	} catch {
		return undefined;
	}
}

// "deep 82%"; a `?` marks a tier taken by default, after a near-tie or without an answer.
function tierLabel(state: RouterState): string {
	if (state.unclassified) return `${state.tier}?`;
	if (state.probability === undefined) return state.tier;
	const mark = state.probability < MIN_PROBABILITY ? "?" : "";
	return `${state.tier}${mark} ${Math.round(state.probability * 100)}%`;
}

// `<family>-*` resolves to the newest `<family>-<major>[-<minor>]` the provider lists, skipping dated
// snapshots, so a new release is used as soon as pi's model catalog has it.
function resolveModel(ctx: ExtensionContext, provider: string, id: string): Model<Api> | undefined {
	if (!id.endsWith("-*")) return ctx.modelRegistry.find(provider, id);
	const pattern = new RegExp(`^${id.slice(0, -1)}(\\d+)(?:-(\\d{1,2}))?$`);
	let newest: Model<Api> | undefined;
	let newestVersion = -1;
	for (const model of ctx.modelRegistry.getAll()) {
		const match = model.provider === provider ? pattern.exec(model.id) : null;
		const version = match ? Number(match[1]) * 100 + Number(match[2] ?? 0) : -1;
		if (version > newestVersion) [newest, newestVersion] = [model, version];
	}
	return newest;
}

export default function (pi: ExtensionAPI) {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	// One JSONL line per routed session, to refit Laya's cuts or train it later. It also covers subagents,
	// which run without a session file; `session` joins pi's session file otherwise, whose
	// thinking_level_change and model_change entries show where the user overrode the route.
	const datasetPath = join(agentDir, "laya-dataset.jsonl");
	const laya = createLaya(pi, agentDir, {
		tier: FALLBACK_TIER,
		model: (ctx) => resolveModel(ctx, TIERS[FALLBACK_TIER].provider, TIERS[FALLBACK_TIER].id),
	});

	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: "auto",
		name: "Auto (classified once)",
		thinkingLevels: ["low", "medium", "high", "xhigh"],
		// Every tier is a Claude model with a 1M window in pi's catalog; Pi uses the routed model's real limits after the first response.
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		async route(request, ctx) {
			// Direct requests (compaction summaries) carry no state; keep them on the session's model.
			if (request.reason === "direct" && request.previous) {
				return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel };
			}
			const prior = request.state;
			const fresh = !prior || (prior.tier === "quick" && request.reason === "user");
			let state = fresh ? undefined : prior;
			if (!state) {
				// Switched off with /laya off: no classification, and no warning since it is deliberate.
				const off = laya.off();
				if (laya.managed && !off) await laya.ensure(request.signal);
				if (!off && ctx.hasUI) ctx.ui.setStatus("router", "classifying…");
				const classified = off ? { tier: FALLBACK_TIER } : await classifyRequest(request, ctx);
				// Throwing ends this request without storing a tier, so a cancelled classification is retried next time.
				if (request.signal?.aborted) {
					if (ctx.hasUI) ctx.ui.setStatus("router", undefined);
					request.signal.throwIfAborted();
				}
				if (laya.managed && !off) laya.touch();
				// A missing laya-serve was already explained once; do not repeat it every session.
				if (!classified && ctx.hasUI && !laya.cannotStart()) {
					ctx.ui.notify(`router/auto: classifier unavailable, using ${FALLBACK_TIER}`, "warning");
				}
				state = classified ?? { tier: FALLBACK_TIER, unclassified: true };
				// A thinking level the user picked earlier in this quick session still wins over Laya's new one.
				if (prior && (!prior.effort || request.thinkingLevel !== prior.userLevel)) {
					const { effort: _effort, userLevel: _userLevel, ...rest } = state;
					state = rest;
				}
			}
			// The user picked another thinking level after Laya chose one; theirs wins for the rest of the session.
			if (state.effort && request.thinkingLevel !== state.userLevel) state = { tier: state.tier, probability: state.probability };
			// footer.ts shows this before the routed model.
			if (ctx.hasUI) ctx.ui.setStatus("router", tierLabel(state));
			const { provider, id } = TIERS[state.tier];
			const model = resolveModel(ctx, provider, id);
			if (!model) throw new Error(`router/auto: ${provider}/${id} is not in the model catalog`);
			if (fresh) {
				const prompt = latestUserText(request.messages).slice(0, MAX_PROMPT_CHARS);
				const record = { time: new Date().toISOString(), session: ctx.sessionManager.getSessionId(), mode: ctx.mode, prompt, ...state, model: `${model.provider}/${model.id}`, thinkingLevel: state.effort ?? request.thinkingLevel };
				try {
					appendFileSync(datasetPath, `${JSON.stringify(record)}\n`);
				} catch {
					// a lost dataset line must never block routing
				}
			}
			// Returning the same state object keeps it; a new object is stored on the first request and
			// when the user overrides Laya's thinking level.
			return { model, thinkingLevel: state.effort ?? request.thinkingLevel, state };
		},
	});
}
