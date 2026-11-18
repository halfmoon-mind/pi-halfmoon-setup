/**
 * laya-serve's process lifecycle for router/auto (router.ts calls createLaya; not a pi extension).
 *
 * With a local LAYA_URL, pi runs laya-serve itself: a router/auto session starts it before the first
 * message, it stops after LAYA_IDLE_MS unused, and it never outlives the pi that started it.
 * `/laya on|off` switches classification for every pi (saved in <agent dir>/laya.json); while off,
 * sessions use FALLBACK_TIER without a warning.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// laya-serve holds ~2.5 GB (measured phys_footprint on MPS) yet only answers each session's first
// message, so it is stopped once unused for this long and started again on demand.
const LAYA_IDLE_MS = 5 * 60_000;
// Measured cold start: ~10 s with the checkpoint already downloaded.
const LAYA_START_TIMEOUT_MS = 30_000;

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

export function createLaya(pi: ExtensionAPI, agentDir: string, fallback: { tier: string; model: (ctx: ExtensionContext) => Model<Api> | undefined }) {
	const laya = (process.env.PI_ROUTER_CLASSIFIER ?? "laya") === "laya";
	const layaUrl = process.env.LAYA_URL ?? "http://127.0.0.1:8000/v1";
	if (laya) {
		pi.registerProvider("typesafe", {
			baseUrl: layaUrl,
			apiKey: "laya-local",
		});
	}

	// The on/off switch is one file shared by every pi, read on each use so a switch applies everywhere.
	const switchPath = join(agentDir, "laya.json");
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

	// Only states that explain a session's tier are shown; a running or idle laya is the normal case.
	async function updateStatus() {
		let text: string | undefined;
		if (layaOff()) text = "laya off";
		else if (await healthy()) text = undefined;
		else if (child) text = "laya starting";
		else if (cannotStart) text = "laya unavailable";
		// Off or unavailable means every session takes FALLBACK_TIER unclassified, so it stands out.
		ui?.setStatus("laya", text && text !== "laya starting" ? ui.theme.fg("warning", text) : text);
	}

	function stopLaya() {
		clearTimeout(idleTimer);
		child?.kill();
		child = undefined;
	}

	// Restarted on spawn and after each classification.
	function touchLaya() {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(async () => {
			// Still loading (the first run downloads the model): stopping it now would restart the download from zero.
			if (child && !(await healthy())) return touchLaya();
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
					`laya: cannot start ${bin} (${error.message}), so router/auto uses the ${fallback.tier} tier without classifying. ` +
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
				const model = fallback.model(ctx);
				ctx.ui.notify(
					layaOff()
						? `laya off: router/auto uses ${model?.provider}/${model?.id} without classifying`
						: `laya on: router/auto classifies each new session (${(await healthy()) ? "running" : child ? "starting" : "starts on demand"} at ${layaUrl})`,
					"info",
				);
			},
		});
	}

	return { off: layaOff, managed, ensure: ensureLaya, touch: touchLaya, cannotStart: () => cannotStart };
}
