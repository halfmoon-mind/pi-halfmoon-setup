/**
 * router/auto - a virtual model that classifies the first user message once, then stays on the
 * chosen model for the rest of the session so the prompt cache is never invalidated by routing.
 * The one exception is a quick (question-only) session, which classifies each new user message
 * until one needs more than Sonnet.
 * The same classification sets the thinking level, until the user picks another one in pi.
 *
 * The classifier is Claude Haiku through the logged-in `claude` CLI, so it draws on subscription limits
 * and takes about 4 s. When it cannot answer, the session uses FALLBACK_TIER and says so once.
 */

import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { PLAN_FIRST } from "./handoff.ts";

// Tier -> physical model. Opus is the default; deep work, and complex work the classifier rates xhigh, run on Fable
// at medium thinking; questions that change no code run on Sonnet at medium. GPT stays in subagents
// (deep-worker, reviewers).
// Claude goes through pi-claude-cli (the logged-in `claude` CLI) so it draws on subscription limits, not extra usage.
// An id ending in `-*` means the newest version of that family the provider lists (see resolveModel).
// ponytail: a Fable session stays on Fable for good; point deep and complex-high at Opus if Fable's allowance runs short.
const TIERS = {
	// Not sticky: a Q&A opener often turns into work, so each new user message is classified again until
	// another tier wins. Moving to Opus costs one cache miss, which a short Q&A history makes cheap.
	quick: { provider: "pi-claude-cli", id: "claude-sonnet-*", thinking: "medium" },
	standard: { provider: "pi-claude-cli", id: "claude-opus-*" },
	complex: { provider: "pi-claude-cli", id: "claude-opus-*", xhigh: "complex-high" },
	deep: { provider: "pi-claude-cli", id: "claude-fable-*", thinking: "medium" },
	// Not offered to the classifier: reached only through complex's `xhigh`, and run at medium thinking.
	"complex-high": { provider: "pi-claude-cli", id: "claude-fable-*", thinking: "medium" },
} as const;
type Tier = keyof typeof TIERS;
const FALLBACK_TIER: Tier = "complex";

const MAX_PROMPT_CHARS = 16_000;
const CLASSIFIER_TIERS = ["quick", "standard", "complex", "deep"] as const; // complex-high is reached only through complex's xhigh
const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
// ponytail: fixed timeout, about 8x Haiku's p50 of 3.8 s; past it the session takes FALLBACK_TIER instead of waiting.
const CLASSIFY_TIMEOUT_MS = 30_000;
// Validated on 30 held-out hand-labelled prompts (28/30); change it only against the dataset log.
const SYSTEM = `You route a coding agent's user request to a model. Answer with the tier and thinking effort.
Tiers:
- quick: a greeting, or a question answerable from general knowledge or the conversation alone, with no need to read code, logs, or files, run commands, or change anything.
- standard: ordinary features, fixes, reviews, or docs; also short follow-ups that tell the agent to carry out or continue work ("진행해", "수정해봐", "1번 진행해봐").
- complex: subtle design, cross-cutting refactors, hard debugging, or investigating why something is wrong, missing, or not behaving as specified.
- deep: logic-heavy algorithms, backend internals, or math with a clear goal.
Effort: low = trivial; medium = routine; high = several steps, files, or tradeoffs; xhigh = subtle correctness, novel algorithms, high-stakes design.
Requests are often in Korean. Questions that ask the agent to check, inspect, or find a cause ("체크해봐", "왜 안나와?", "원인 파악") are investigations, not quick.`;
const SCHEMA = JSON.stringify({ type: "object", properties: { tier: { enum: CLASSIFIER_TIERS }, effort: { enum: EFFORTS } }, required: ["tier", "effort"] });

interface RouterState {
	tier: Tier;
	// The classifier could not answer, so `tier` is FALLBACK_TIER by default rather than by choice.
	unclassified?: true;
	// Thinking level the classifier chose, and the user's level at the time; picking another level in pi drops it.
	effort?: ModelRouteRequest["thinkingLevel"];
	userLevel?: ModelRouteRequest["thinkingLevel"];
}

// The latest user message: the first one for a new session, the new one when a quick session reclassifies.
// handoff's plan-first note reaches the router as a user message after the real one; skip it.
function latestUserText(messages: readonly Message[]): string {
	const text = (content: Message["content"]) =>
		typeof content === "string" ? content : content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const texts = messages.flatMap((message) => (message.role === "user" ? [text(message.content)] : []));
	return texts.findLast((t) => t !== PLAN_FIRST) ?? "";
}

async function classifyRequest(request: ModelRouteRequest<RouterState>): Promise<RouterState | undefined> {
	try {
		// The prompt goes on stdin: `--tools ""` would take a positional after it as its value. Bare mode
		// stays off: it skips OAuth and the keychain, so a subscription login could not answer.
		// SIGKILL on timeout and abort alike: a CLI that ignores SIGTERM would outlive both.
		const run = promisify(execFile)("claude", ["-p", "--model", "haiku", "--output-format", "json", "--json-schema", SCHEMA, "--no-session-persistence", "--tools", "", "--setting-sources=", "--strict-mcp-config", "--disable-slash-commands", "--system-prompt", SYSTEM], { timeout: CLASSIFY_TIMEOUT_MS, killSignal: "SIGKILL" });
		// Not execFile's `signal` option: it aborts with SIGTERM whatever killSignal says (Node 22).
		const abort = () => run.child.kill("SIGKILL");
		request.signal?.addEventListener("abort", abort, { once: true });
		if (request.signal?.aborted) abort();
		// Without claude the write fails with EPIPE; `run` already rejects with ENOENT, so the stream error is dropped.
		run.child.stdin?.on("error", () => {});
		run.child.stdin?.end(latestUserText(request.messages).slice(0, MAX_PROMPT_CHARS));
		const result = JSON.parse((await run).stdout);
		const answer = result.is_error ? undefined : result.structured_output;
		if (!CLASSIFIER_TIERS.includes(answer?.tier) || !EFFORTS.includes(answer?.effort)) return undefined;
		const t = TIERS[answer.tier as Tier];
		const tier: Tier = answer.effort === "xhigh" && "xhigh" in t ? t.xhigh : answer.tier;
		const routed = TIERS[tier];
		return { tier, effort: "thinking" in routed ? routed.thinking : answer.effort, userLevel: request.thinkingLevel };
	} catch {
		return undefined;
	}
}

// A `?` marks a tier taken by default, without an answer.
function tierLabel(state: RouterState): string {
	return state.unclassified ? `${state.tier}?` : state.tier;
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
	// One JSONL line per routed session, to check the classifier against what the user did. It also covers
	// subagents, which run without a session file; `session` joins pi's session file otherwise, whose
	// thinking_level_change and model_change entries show where the user overrode the route. The earlier
	// classifier's cuts are gone; the file keeps its name for continuity.
	const datasetPath = join(agentDir, "laya-dataset.jsonl");

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
				if (ctx.hasUI) ctx.ui.setStatus("router", "classifying…");
				const classified = await classifyRequest(request);
				// Throwing ends this request without storing a tier, so a cancelled classification is retried next time.
				if (request.signal?.aborted) {
					if (ctx.hasUI) ctx.ui.setStatus("router", undefined);
					request.signal.throwIfAborted();
				}
				// A failed session lands on FALLBACK_TIER, which is never classified again, so this warns once per session.
				if (!classified && ctx.hasUI) {
					ctx.ui.notify(`router/auto: classifier unavailable, using ${FALLBACK_TIER}`, "warning");
				}
				state = classified ?? { tier: FALLBACK_TIER, unclassified: true };
				// A thinking level the user picked earlier in this quick session still wins over the classifier's new one.
				if (prior && (!prior.effort || request.thinkingLevel !== prior.userLevel)) {
					const { effort: _effort, userLevel: _userLevel, ...rest } = state;
					state = rest;
				}
			}
			// The user picked another thinking level after the classifier chose one; theirs wins for the rest of the session.
			if (state.effort && request.thinkingLevel !== state.userLevel) state = { tier: state.tier };
			// footer.ts shows this before the routed model.
			if (ctx.hasUI) ctx.ui.setStatus("router", tierLabel(state));
			const { provider, id } = TIERS[state.tier];
			const model = resolveModel(ctx, provider, id);
			if (!model) throw new Error(`router/auto: ${provider}/${id} is not in the model catalog`);
			if (fresh) {
				const prompt = latestUserText(request.messages).slice(0, MAX_PROMPT_CHARS);
				const record = { time: new Date().toISOString(), session: ctx.sessionManager.getSessionId(), mode: ctx.mode, classifier: "haiku", prompt, ...state, model: `${model.provider}/${model.id}`, thinkingLevel: state.effort ?? request.thinkingLevel };
				try {
					appendFileSync(datasetPath, `${JSON.stringify(record)}\n`);
				} catch {
					// a lost dataset line must never block routing
				}
			}
			// Returning the same state object keeps it; a new object is stored on the first request and
			// when the user overrides the classifier's thinking level.
			return { model, thinkingLevel: state.effort ?? request.thinkingLevel, state };
		},
	});
}
