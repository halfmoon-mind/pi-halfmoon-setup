import { deepMerge } from "./merge.mjs";

export const DEFAULTS = { server: { host: "localhost", port: 8080 }, tags: ["web"], debug: false };

// The defaults with the overrides deep-merged on top.
export function loadConfig(defaults, overrides = {}) {
	return deepMerge(defaults, overrides);
}
