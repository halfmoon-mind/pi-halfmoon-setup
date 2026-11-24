# LRU cache with TTL

## Goal
`new Cache({ max, ttlMs, now })` holds at most `max` entries, evicting the least recently used one, and with `ttlMs` its entries expire. This evaluation asks for the implementation's behavior only, not new tests.

## Plan
- [ ] 1. Limit the cache to `max` entries with LRU eviction. - files: src/cache.mjs - check: `node --test`
  `max` must be an integer ≥ 1, otherwise (including a missing `max`) the constructor throws a RangeError. Setting a new key when the cache holds `max` entries first evicts the least recently used entry. `get` of a present key and `set` of an existing key make that key the most recently used; `has` does not change recency.
- [ ] 2. Add an optional time-to-live. - files: src/cache.mjs - check: `node --test`
  The constructor also takes `ttlMs` (optional; when given it must be a positive number, otherwise RangeError) and `now` (a function returning milliseconds, default `Date.now`). `set` stamps the entry with `expires = now() + ttlMs`; the entry is expired when `now() >= expires`. `get` and `has` of an expired entry return `undefined` and `false` and delete it. `set` of an existing key resets its TTL; `get` does not extend it. Without `ttlMs` entries never expire.
- [ ] 3. Expired entries do not count. - files: src/cache.mjs - check: `node --test`
  `size` counts only unexpired entries. When `set` needs room for a new key it first drops every expired entry, and evicts the least recently used entry only if the cache is still full.

## Not doing
No background timers, no per-entry TTL, no `delete` or `clear`.

## Success criteria
- `node --test`
