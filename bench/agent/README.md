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
gate-eval.ts              the review gate's own eval, no implementer-agent run; writes gate-results/
tasks/<id>/omit/<name>/   the solution with one stated rule dropped, overlaying solution/; used only by gate-eval.ts
tasks/<id>/gate-plan.md   the gate eval's behavior-only plan, used instead of plan.md by gate-eval.ts
followup-eval.ts          the decision check's eval on your own session logs; writes only under <agent dir>/followup-eval/
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

## Gate eval

Whether the review gate BLOCKs changes that leave out something the request asks for, without the noise of an implementer run. For each task with an `omit/` dir, it builds `full` (the reference solution) and each `omit/<name>` variant: `repo/` committed as the base in a fresh temp git repo, then `solution/` and the variant copied on top, uncommitted. The reviewer gets the text the gate itself sends, from `reviewTask` in `extensions/review-gate.ts`: `task.md` as the only user message, an empty tool log, and the fixed final message `Done. All tests pass.`. A task with a plan gets it untracked at `docs/plans/<id>.md` with every step ticked; `plan-lru-ttl` uses `gate-plan.md`, its `plan.md` without the test-writing sentences, since the solutions hold src files only and the original plan would make `full` incomplete too.

```bash
node --import ./extensions/test-hooks.ts bench/agent/gate-eval.ts --dry
node --import ./extensions/test-hooks.ts bench/agent/gate-eval.ts --label <name> --repeat 3
node --import ./extensions/test-hooks.ts bench/agent/gate-eval.ts --report [--label <name>]
```

`--dry` makes no model calls: per (task, variant), the visible tests pass, the plan lints clean, `full` passes the hidden test and each omission fails it. A real run writes `gate-results/<label>/<id>__<variant>__r<n>.json` with the decision (`NONE` when the review has no verdict line; there is no extraction fallback), reason, model, cost, duration, the review, the reviewer's attempted bash tool calls (`bash`) and whether the repository's snapshot changed during the review (`repoChanged`, by the gate's own `snapshot`; ignored untracked files are excluded, and an unchanged snapshot does not prove no writes occurred); a result already there is skipped, and a failed reviewer run writes nothing and keeps its temp dir. `--report` gives per label the recall (BLOCKs over omission runs, `NONE` counting as not BLOCK) and the false-block rate (BLOCKs over `full` runs), then BLOCKs per task and variant. A BLOCK for some other reason still counts in the report, so read the reasons.

The reviewer is this checkout's `agents/reviewer.md`, unless `<agent dir>/agents/reviewer.md` overrides it, run through `pi` on PATH (put `~/.pi/agent/bin` first). Real runs are manual and billed: one reviewer invocation per (task, variant, repeat), so 12 × N, each up to 10 minutes and possibly several inference and tool turns.

## Follow-up eval

Whether the review gate's decision check (a no-change reply that asks the user something gets one `gpt-6.1-terra` call for what it leaves out) names what the user then asks about. It mines the session logs under `<agent dir>/sessions` (temp-run dirs skipped) for user messages after a reply: a positive is a follow-up asking whether something was considered (200 characters or less, a `?`, and a word such as 고려, 빠뜨, 포함, `왜 … 안`, `considered`, `what about`); a negative is a plain go-ahead of 20 characters or less (진행, ㄱㄱ, 네, ok, `1번`). The turn before it is eligible when it passes the gate's free pre-filter (`decisionSkip`: a reply with a `?` in its last paragraph, no review, triage or plan-check message after the user's), made no `edit` or `write` call, and showed no decision check. Each fixture is the turn as the check sees it: the last three user messages, the run's thinking and the reply.

```bash
node --import ./extensions/test-hooks.ts bench/agent/followup-eval.ts --dry
node --import ./extensions/test-hooks.ts bench/agent/followup-eval.ts --label <name>
node --import ./extensions/test-hooks.ts bench/agent/followup-eval.ts --report [--label <name>]
```

`--dry` makes no model call and writes nothing: it counts positives and negatives by why each is or is not eligible, so `no question` is how many follow-ups the `?` pre-filter misses. `--label` runs the check (`checkDecision`, the gate's own call) on each eligible fixture without a result, and for a positive with items one grading call asking whether any gap raises the follow-up's concern. `--report` gives per label the recall (positives whose gaps cover the follow-up, a positive with no items counting as missed) and the noise (negatives with at least one item).

Fixtures and results are your private conversations, so they are kept under `<agent dir>/followup-eval/<label>/<id>.json` and never in the repository. Real runs are manual and billed: one terra call per eligible fixture plus one grading call per positive with items.
