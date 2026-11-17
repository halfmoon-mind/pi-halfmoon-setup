# Deep-merged config

## Goal
`loadConfig(defaults, overrides)` merges nested objects instead of replacing them, while an override array replaces the default array whole.

## Plan
- [ ] 1. Add `deepMerge(base, override)` in a new module. - files: src/merge.mjs (new), test/merge.test.mjs (new) - check: `node --test test/merge.test.mjs`
  It returns a new object and mutates neither input. For each key of `override`: when both values are plain objects (not arrays, not null), merge them recursively; otherwise the override value wins, so an array replaces the base array whole (copied, not shared) and `null` replaces an object. Keys only in `base` are kept. Test nesting, array replacement, `null`, and that the inputs are unchanged.
- [ ] 2. Use it in `loadConfig`. - files: src/config.mjs, test/config.test.mjs - check: `node --test test/config.test.mjs`
  `loadConfig(defaults, overrides = {})` returns `deepMerge(defaults, overrides)`. Add a test where `{ server: { port: 1 } }` over the defaults keeps `server.host`.

## Not doing
No config files on disk and no merge options.

## Success criteria
- `node --test`
