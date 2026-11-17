# Agent eval

How reliable pi's harness is with a given model: whether a run's code passes a hidden test, and whether its final reply claims done when it does not (a false done), with the review gate and plan checks on (`gate`) and off (`nogate`).

```
run.ts                    runs the tasks through `pi -p`, grades, writes results/
report.ts                 one markdown row per model × arm from results/
metrics.ts                a session's counts; malformed session data is a run error, not zeros (node --test bench/agent/metrics.test.ts)
tasks/<id>/task.md        the prompt
tasks/<id>/repo/          the fixture: plain .mjs, src/ and test/*.test.mjs, no dependencies
tasks/<id>/hidden.test.mjs the grading test, copied into the repo root after the run
tasks/<id>/plan.md        plan-kind tasks only: the prompt is the handoff kickoff for it
tasks/<id>/solution/       the reference fix: src files overlaying repo/, checked by --dry, never copied into a run
```

## Check the fixtures

```bash
node --import ./extensions/test-hooks.ts bench/agent/run.ts --dry
```

Per task, in a fresh temp copy: the visible tests pass, the hidden test fails (a timeout or spawn error is a FAIL, not the expected failure), and a plan lints clean. Then, in a second fresh copy with `solution/` overlaid, the visible and hidden tests pass; a task without a `solution/` FAILs. It makes no model calls, but it imports the installed pi packages through `extensions/test-hooks.ts` (the managed install under `~/.pi/agent/install`).

## Tasks for a weak model

The first eight tasks were passed by haiku without the gate, so these six are built to catch what a weak model skips. Each rule the hidden test checks is written in the task (or plan); only the visible tests leave it out.

| Task | What tempts a weak model |
|---|---|
| `root-cause-sibling` | Patching only `cartTotal`, the caller the report names, instead of the shared `toCents` |
| `csv-quoted` | Stopping at the one quoted case the visible test shows |
| `async-pool` | One call too many in flight, or starting items after a rejection |
| `many-requirements` | Skipping some of the 9 rules, or their order |
| `business-days` | Holidays, a negative n, n = 0 on a weekend |
| `plan-lru-ttl` | `get` extending the TTL, `size` counting expired entries, evicting a live entry while an expired one remains |

## A real run

```bash
node --import ./extensions/test-hooks.ts bench/agent/run.ts --model <m> --arm gate --repeat 3
node --import ./extensions/test-hooks.ts bench/agent/run.ts --model <m> --arm nogate --repeat 3
node bench/agent/report.ts
```

Each run copies the fixture into a temp git repo (sessions go in a sibling dir, outside it) and runs `pi -p --session-dir <tmp>/sessions --model <m> <prompt>` there, with `PI_EVAL=1` for the gate arm, so print mode gets the plan-first note, handoff, plan checks and the review gate. Then it runs `node --test` with the hidden test added (pass = exit 0), reads the session's tool errors, review verdicts and plan-check rounds, and asks `claude -p --model sonnet` whether the final reply claims done (its raw answer is kept as `grader`). A result already in `results/` is skipped; a run error (pi failing, a missing session, a grader answer other than YES or NO) writes nothing and keeps the temp dir.

It needs Node 22.19+, managed pi with this checkout installed (the bench measures what pi loads), a logged-in `claude`, and for the gate arm the review gate on (`/review-gate on`; the runner refuses while it is off). Real runs are manual and billed: each is one pi run on the model, a sonnet grade, and in the gate arm one or more GPT reviewer calls.

`report.ts`: runs, pass rate, false-done rate, verdict compliance (reviews that gave a verdict), edit errors and plan-check rounds per run.
