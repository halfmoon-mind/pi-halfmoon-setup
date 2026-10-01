// Resolves imports the way pi's extension loader (jiti + aliases) does, so extensions that use pi at
// runtime can run under `node --test`: pi packages come from the installed pi, and `./x.js` may name `./x.ts`.
// Run: node --import ./extensions/test-hooks.ts --test 'extensions/**/*.test.ts'
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

// ponytail: only pi's managed install (~/.pi/agent/install); point this elsewhere if pi is installed another way.
const install = `${homedir()}/.pi/agent/install`;
const release = `${install}/releases/${readFileSync(`${install}/current-version`, "utf8").trim()}`;
// Resolve from pi-coding-agent itself, as pi does: its dependencies may be hoisted or nested under it.
const piRoot = pathToFileURL(`${release}/node_modules/@earendil-works/pi-coding-agent/package.json`).href;

registerHooks({
	resolve(specifier, context, next) {
		const name = specifier.replace(/^@mariozechner\//, "@earendil-works/");
		// pi hands extensions pi-ai's compat entry, a superset of the core one.
		if (name === "@earendil-works/pi-ai") return next(`${name}/compat`, { ...context, parentURL: piRoot });
		if (name.startsWith("@earendil-works/") || name === "typebox") return next(name, { ...context, parentURL: piRoot });
		if (/^\.\.?\/.*\.js$/.test(specifier) && context.parentURL) {
			const ts = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
			if (existsSync(ts)) return next(ts.href, context);
		}
		return next(specifier, context);
	},
});
