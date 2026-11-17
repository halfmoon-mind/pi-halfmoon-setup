export const DEFAULTS = { server: { host: "localhost", port: 8080 }, tags: ["web"], debug: false };

// The defaults with the overrides on top.
export function loadConfig(defaults, overrides = {}) {
	return { ...defaults, ...overrides };
}
