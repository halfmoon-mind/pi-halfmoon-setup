`validateUser(user)` in `src/validate.mjs` returns a list of error strings, `[]` when the user is valid, but it only checks the name and a bare `@` in the email. Make it apply these 9 rules, with exactly these strings, the errors in rule order:
1. `user` that is not an object, is `null` or is an array: return only `["user must be an object"]` and check nothing else.
2. `"name is required"`: `name` is not a string, or is empty after trimming.
3. `"email is invalid"`: `email` is not a string matching `/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/`.
4. `"age must be an integer"`: `!Number.isInteger(age)`, which includes a missing age.
5. `"age must be between 13 and 120"`: only when rule 4 passes; 13 and 120 are allowed.
6. `"tags must be an array of strings"`: only when `tags` is not `undefined`; it must be an array whose every item is a string.
7. `"tags must be lowercase"`: once, when any tag differs from its `toLowerCase()`; only when rule 6 passes.
8. `"tags must be unique"`: once, when two tags are equal by exact (`===`) comparison; only when rule 6 passes.
9. `"unknown field: <key>"`: one error per key other than `name`, `email`, `age` and `tags`, in `Object.keys(user)` order.

It never throws. Keep the existing tests passing.
