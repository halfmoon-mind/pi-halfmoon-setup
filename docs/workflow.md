# Workflow

**English** | [한국어](workflow.ko.md)

## Plan first and handoff

You do not need a command for this. In an interactive session, every request comes with a short note asking the model whether it needs a plan. A quick fix (one change you can state in one sentence, with no design choice) is built directly. Anything else is planned first: the model reads the code, looks up outside docs if it has web search, runs `planner` and `plan-reviewer`, and writes the plan to `docs/plans/<name>.md`: each checkbox step line ends with ``- files: a.ts, b.ts (new) - check: `<command>` ``, and `## Success criteria` has one `` - `<command>` `` line per command. The `handoff` tool refuses a plan until `plan-reviewer` has run in the session, and refuses one not in that format with the problems listed; a plan this session already accepted, or one opened by `/handoff`, is exempt. When the plan touches three or more files, or changes a stored data format or a public interface, pi shows a summary and waits for your go-ahead.

Then the model calls the `handoff` tool, which decides where the build runs:

| Session state | Build runs |
|---|---|
| Context 50% full or more, or compacted at least once | In a new session that starts from the plan file, with the old session as its parent |
| Messy in the model's judgment (it sees the counts of failed tool calls and review `BLOCK`s) | In a new session, when the model asks for one |
| Otherwise | Here, through the `worker` subagent |

While building, the model ticks each step in the plan file, calls `handoff` again between steps so a session that fills up mid-build hands off the rest, and does not finish until every success criteria command passes. A worker's pi has no `handoff` tool, so a worker whose context gets compacted finishes its current step and stops; the main session calls `handoff` again and gives the steps left to a fresh worker. A plan may tag independent, substantial steps that edit separate files as one parallel group. The building session runs the group as one parallel subagent call with a worker per step, then checks and ticks those steps itself, since the workers share one working tree. The review gate also checks ticked steps against the code, and since plans stay out of git, a tick alone counts as a change to review. Before that review, the harness itself runs the check of each step the request ticked, then the success criteria once no step is left; a failing command goes back to the model with the end of its output, to fix the code or untick the step (at most three rounds per request). A plan judges a request while it has steps left, or when that request ticked steps in it. `/handoff <plan>` starts a plan in a new session by hand. Either way, the new session's first message includes the plan's text, so the router picks its tier and thinking effort from the plan rather than from a generic kickoff.

Plan files stay out of git: when pi starts in a repository that does not ignore `docs/plans/` already, it adds that line to `.git/info/exclude`, which is local and never committed.

## Review gate

Like the Codex plugin's stop-time review in Claude Code: when a prompt's run changed the repository, the `reviewer` agent reviews those changes before pi stops. It also gets your last three messages (a long one cut to its start and end) and the tool calls the run made with how each ended, so it can check that the changes do what you asked and that a claimed check really ran and passed; this text goes to the `openai` provider. Its first line is `ALLOW` or `BLOCK`, read tolerantly (any case, markdown such as `**BLOCK:**` around it); a review with no verdict line goes to `gpt-6.1-terra` on `openai` to extract one. A `BLOCK` goes back to the model as a message to fix the issue or explain why it is not one, and to write its final reply as the full report on your request, with the fix as a short note at the end. Work from a plan is also checked against the steps the plan ticks. Each prompt gets at most three reviews, and a change after the third shows a warning that it went unreviewed. A failed or timed-out review, or one with no verdict, never blocks: the footer shows `unreviewed` until the next prompt, and the session records the verdict as `NONE`. Only interactive sessions (and print mode under `PI_EVAL=1`) are gated, so subagents never review themselves. While the gate is off, the footer shows `review off`. While a review runs, it shows `reviewing…`; Esc cannot stop it, but it times out after 10 minutes.

| pi command | Action |
|---|---|
| `/review-gate` | Show whether the gate is on |
| `/review-gate on` | Turn the gate on (the default) |
| `/review-gate off` | Turn the gate off for every pi that shares this config directory |

## Timing

While a prompt runs, the footer shows `⏱ 42s · agent 30s · bash 12s`, updated every second: the total so far, the agent time so far, and the top-level tool that has been running longest, while one runs. After the prompt settles, one dim line in the chat sums it up:

```text
⏱ total 1m 23s · agent 58s · bash 41s ×12, subagent 30s ×2, read 2.0s ×5
```

- **total** — wall time from the prompt's start until pi settles, including the review gate, retries and continuations.
- **agent** — the time the agent ran (model and tools), leaving out the review gate and other settle work.
- **tools** — the top three tools by time, with how many calls each made. Calls made by another tool (a codemode script's) are not counted again, and parallel calls overlap, so tool times can add up to more than the total.

An aborted prompt's line ends in `(aborted)`. While a confirm or select prompt waits for you, the total, agent and live tool times keep counting; the summary's tool times do not. Only interactive (tui) sessions are timed, so subagents and print/json mode show nothing. The line is not saved in the session.
