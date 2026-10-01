/**
 * router/auto - a virtual model that classifies the first user message once, then stays on the
 * chosen model for the rest of the session so the prompt cache is never invalidated by routing.
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
 * With a local LAYA_URL, pi runs laya-serve itself: a router/auto session starts it before the first
 * message, it stops after LAYA_IDLE_MS unused, and it never outlives the pi that started it.
 * `/laya on|off` switches classification for every pi (saved in <agent dir>/laya.json); while off,
 * sessions use FALLBACK_TIER without a warning.
 *
 * When the classifier is unavailable, the session falls back to FALLBACK_TIER and says so once.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

// Tier -> physical model. Role split follows oh-my-openagent's agent-model-matching guide.
// Claude goes through pi-claude-cli (the logged-in `claude` CLI) so it draws on subscription limits, not extra usage.
// An id ending in `-*` means the newest version of that family the provider lists (see resolveModel).
const TIERS = {
	standard: { provider: "pi-claude-cli", id: "claude-sonnet-*", criteria: "Ordinary features, fixes, reviews, docs, or questions" },
	complex: { provider: "pi-claude-cli", id: "claude-opus-*", criteria: "Subtle design, cross-cutting refactors, or hard debugging" },
	deep: { provider: "openai", id: "gpt-6.1-sol", criteria: "Logic-heavy algorithms, backend internals, or math with a clear goal" },
} as const;
type Tier = keyof typeof TIERS;
const FALLBACK_TIER: Tier = "complex";

// Laya's per-request state limit is 50k chars; the opening request is what decides the tier.
const MAX_PROMPT_CHARS = 16_000;
// ponytail: fixed threshold; below it the answer is a near-tie (seen: 0.363 vs 0.359), so take
// FALLBACK_TIER rather than risk routing hard work down. Tune from logged probabilities if needed.
const MIN_PROBABILITY = 0.5;

// laya-serve holds ~2.5 GB (measured phys_footprint on MPS) yet only answers each session's first
// message, so it is stopped once unused for this long and started again on demand.
const LAYA_IDLE_MS = 5 * 60_000;
// Measured cold start: ~10 s with the checkpoint already downloaded.
const LAYA_START_TIMEOUT_MS = 30_000;

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

/**
 * Spawns `command` so it cannot outlive this process, even on SIGKILL or a crash: a `sh` lifeline
 * blocks reading a pipe from us, and when we die the OS closes the pipe and the lifeline kills the
 * child. macOS has no PR_SET_PDEATHSIG, so this is the portable way. Both get their own process
 * group so terminal signals (Ctrl+C) do not reach them, and Node reaps both, so no zombies either.
 */
export function spawnWithLifeline(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
	const child = spawn(command, args, { env, detached: true, stdio: "ignore" });
	if (child.pid === undefined) return child; // spawn failed; the caller gets the 'error' event
	const lifeline = spawn("sh", ["-c", 'read _; kill "$0"', String(child.pid)], {
		detached: true,
		stdio: ["pipe", "ignore", "ignore"],
	});
	child.on("exit", () => lifeline.kill());
	// Neither keeps pi's event loop alive; pi exiting is exactly what stops them.
	child.unref();
	lifeline.unref();
	(lifeline.stdin as Socket).unref();
	return child;
}

export default function (pi: ExtensionAPI) {
	const laya = (process.env.PI_ROUTER_CLASSIFIER ?? "laya") === "laya";
	const layaUrl = process.env.LAYA_URL ?? "http://127.0.0.1:8000/v1";
	if (laya) {
		pi.registerProvider("typesafe", {
			baseUrl: layaUrl,
			apiKey: "laya-local",
		});
	}

	// The on/off switch is one file shared by every pi, read on each use so a switch applies everywhere.
	const switchPath = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "laya.json");
	const layaOff = () => {
		if (!laya) return false;
		try {
			return JSON.parse(readFileSync(switchPath, "utf8")).enabled === false;
		} catch {
			return false;
		}
	};

	// pi only starts and stops a laya-serve on this machine; a remote LAYA_URL is someone else's server.
	const { hostname, port } = new URL(layaUrl);
	const managed = laya && (hostname === "127.0.0.1" || hostname === "localhost");
	const healthUrl = new URL("/health", layaUrl);
	const healthy = () => fetch(healthUrl, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
	let child: ChildProcess | undefined; // the laya-serve this pi started, if any
	// laya-serve is not installed (or not executable): say how to fix it once, then stop retrying
	// and stop warning on every session. /laya on retries.
	let cannotStart = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let ui: ExtensionContext["ui"] | undefined;

	async function updateStatus() {
		let text = "laya idle";
		if (layaOff()) text = "laya off";
		else if (await healthy()) text = "laya on";
		else if (child) text = "laya starting";
		else if (cannotStart) text = "laya unavailable";
		ui?.setStatus("laya", text);
	}

	function stopLaya() {
		clearTimeout(idleTimer);
		child?.kill();
		child = undefined;
	}

	// Restarted on spawn and after each classification.
	function touchLaya() {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			stopLaya();
			void updateStatus();
		}, LAYA_IDLE_MS);
		idleTimer.unref();
	}

	// Resolves once laya answers, or gives up after LAYA_START_TIMEOUT_MS or if it exits; the caller's
	// classification then fails and takes the usual fallback.
	async function ensureLaya(signal?: AbortSignal) {
		if (await healthy()) return;
		if (!child && !cannotStart) {
			const bin = process.env.LAYA_SERVE_BIN ?? "laya-serve";
			const started = spawnWithLifeline(bin, [], {
				...process.env,
				LAYA_HOST: hostname,
				LAYA_PORT: port || "80",
				LAYA_MODELS: process.env.LAYA_MODELS ?? "english",
			});
			const forget = () => {
				if (child !== started) return;
				child = undefined;
				void updateStatus();
			};
			started.on("error", (error) => {
				cannotStart = true;
				ui?.notify(
					`laya: cannot start ${bin} (${error.message}), so router/auto uses the ${FALLBACK_TIER} tier without classifying. ` +
						'Install laya with pip install "laya[serve]" and set LAYA_SERVE_BIN unless laya-serve is on PATH, or run /laya off to hide this.',
					"warning",
				);
				forget();
			});
			started.on("exit", forget);
			child = started;
			touchLaya();
			void updateStatus();
		}
		const deadline = Date.now() + LAYA_START_TIMEOUT_MS;
		while (child && Date.now() < deadline) {
			await delay(250, undefined, { signal });
			if (await healthy()) return void updateStatus();
		}
	}

	// /laya off also stops a laya-serve this pi did not start (another pi's, or one started by hand).
	function stopLayaOnPort() {
		try {
			const pid = execFileSync("lsof", ["-ti", `tcp:${port || "80"}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n")[0];
			if (execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).includes("laya-serve")) process.kill(Number(pid));
		} catch {
			// nothing listening, or not laya-serve
		}
	}

	if (laya) {
		const isRouter = (model?: { provider: string; id: string }) => model?.provider === "router" && model.id === "auto";
		const prewarm = () => {
			if (managed && !layaOff()) ensureLaya().catch(() => {});
		};
		pi.on("session_start", (_event, ctx) => {
			ui = ctx.hasUI ? ctx.ui : undefined;
			if (isRouter(ctx.model)) prewarm();
			void updateStatus();
		});
		pi.on("model_select", (event) => {
			if (isRouter(event.model)) prewarm();
		});
		pi.on("session_shutdown", (event) => {
			// Reload replaces this runtime and its `child` handle; the new runtime starts laya again.
			if (event.reason === "quit" || event.reason === "reload") stopLaya();
		});
		pi.registerCommand("laya", {
			description: "Show the laya classifier, or switch it for every pi: /laya [on|off]",
			getArgumentCompletions: (prefix) =>
				["on", "off"].filter((arg) => arg.startsWith(prefix)).map((arg) => ({ value: arg, label: arg })),
			async handler(args, ctx) {
				const arg = args.trim();
				if (arg !== "" && arg !== "on" && arg !== "off") {
					ctx.ui.notify("usage: /laya [on|off]", "warning");
					return;
				}
				if (arg) {
					mkdirSync(dirname(switchPath), { recursive: true });
					writeFileSync(switchPath, `${JSON.stringify({ enabled: arg === "on" })}\n`);
					if (arg === "on") cannotStart = false;
				if (arg === "on" && managed) ensureLaya().catch(() => {});
					if (arg === "off" && managed) child ? stopLaya() : stopLayaOnPort();
				}
				await updateStatus();
				const { provider, id } = TIERS[FALLBACK_TIER];
				const fallback = resolveModel(ctx, provider, id);
				ctx.ui.notify(
					layaOff()
						? `laya off: router/auto uses ${fallback?.provider}/${fallback?.id} without classifying`
						: `laya on: router/auto classifies each new session (${(await healthy()) ? "running" : child ? "starting" : "starts on demand"} at ${layaUrl})`,
					"info",
				);
			},
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
				// Switched off with /laya off: no classification, and no warning since it is deliberate.
				const off = layaOff();
				if (managed && !off) await ensureLaya(request.signal);
				const tier = off ? FALLBACK_TIER : await classifyTier(request, ctx);
				// Throwing ends this request without storing a tier, so a cancelled classification is retried next time.
				request.signal?.throwIfAborted();
				if (managed && !off) touchLaya();
				// A missing laya-serve was already explained once; do not repeat it every session.
				if (!tier && ctx.hasUI && !cannotStart) {
					ctx.ui.notify(`router/auto: classifier unavailable, using ${FALLBACK_TIER}`, "warning");
				}
				state = { tier: tier ?? FALLBACK_TIER };
			}
			const { provider, id } = TIERS[state.tier];
			const model = resolveModel(ctx, provider, id);
			if (!model) throw new Error(`router/auto: ${provider}/${id} is not in the model catalog`);
			// Returning the same state object keeps it; a new object is stored once, on the first request.
			return { model, thinkingLevel: request.thinkingLevel, state };
		},
	});
}
