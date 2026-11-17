# pi-halfmoon-setup

**English** | [한국어](README.ko.md)

[![test](https://github.com/halfmoon-mind/pi-halfmoon-setup/actions/workflows/test.yml/badge.svg)](https://github.com/halfmoon-mind/pi-halfmoon-setup/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A personal [pi](https://pi.dev) package that picks a model from the first request and splits work across role-based agents.**

Use the same model router, subagents, and workflow prompts on every machine. `router/auto` classifies the first user message once and keeps the chosen tier for the whole session, so repeated model switches never break the prompt cache. The exception is a question-only `quick` session, which classifies each new message until one needs more than Sonnet.

![Diagram of a router that keeps the session on Opus and runs logic-heavy or very hard work on Fable, and of the scout, planner, worker, and reviewer roles](docs/images/overview.svg)

## Features

- **Per-session routing** — keeps the main session on Opus, runs logic-heavy (`deep`) and very hard work on Fable, and sets thinking to match.
- **Role-based subagents** — explore, plan, implement, and review in isolated contexts.
- **Workflow commands** — chain work with `/implement`, `/scout-and-plan`, and `/implement-and-review`.
- **Plan first, build in a clean context** — a code change bigger than a quick fix gets a reviewed plan file first, and its build moves to a new session or a worker subagent depending on how full the session is.
- **Stop-time review gate** — another model family reviews each prompt's changes before pi stops, and sends blocking issues back.
- **Prompt timing** — the footer ticks the elapsed time while a prompt runs, and one line after it gives the total, the agent time, and the slowest tools.
- **Claude CLI provider** — uses your logged-in `claude` CLI as a pi model provider.
- **PDF reading** — `read` sends each PDF page's text, plus an image of only the pages with figures or no text.
- **Office file reading** — `read` sends Word, Excel and PowerPoint files as text with tracked changes, comments, formulas, chart data and speaker notes, plus an image of only the slides that need one.
- **Optional local classifier** — starts and stops Laya automatically, and falls back to Opus when it cannot classify.
- **Sandbox** — bash runs in an OS sandbox that writes only in the project and temp dirs, reaches only allowed hosts, and cannot read the listed credential paths; pi's file tools follow the same paths, and a few risky actions ask first.

## Quick start

### 1. Prerequisites and install

`pi` and Claude Code's `claude` command must be on your PATH, poppler for reading PDFs and pandoc for Word files (`brew install poppler pandoc`), LibreOffice for PowerPoint slide images (`brew install --cask libreoffice`; without it, those slides come with their embedded pictures only), and ripgrep for the bash sandbox (`brew install ripgrep`; on Linux also bubblewrap and socat: `apt-get install bubblewrap socat ripgrep`). This repository is not a standalone app; it is a package that pi loads.

```bash
pi install git:github.com/halfmoon-mind/pi-halfmoon-setup
claude auth login
```

To use a local checkout instead, install its dependency and then the checkout (pi does not install dependencies for a local source). After editing, run `/reload` in pi to load the changes.

```bash
cd ~/projects/pi-halfmoon-setup && npm ci
pi install ~/projects/pi-halfmoon-setup
```

The `reviewer`, `plan-reviewer`, and `deep-worker` agents and the review gate use the `openai` provider, so set up its authentication too. With an environment variable:

```bash
export OPENAI_API_KEY="<your-api-key>"
```

### 2. Install Laya (optional)

For automatic classification, install the Laya server.

```bash
pip install "laya[serve]"
```

If `laya-serve` is not on your PATH, for example because it lives in a virtualenv, point to the executable. Replace the path below with your install location.

```bash
export LAYA_SERVE_BIN="$HOME/projects/laya/.venv/bin/laya-serve"
```

Without Laya, the router uses Opus from the `complex` tier. If you plan to run without classification, run `/laya off` in pi.

### 3. Run

```bash
pi --model router/auto
```

You can also pick `router/auto` with `/model` while pi is running. If you use Laya, check its state with `/laya`.

At startup, pi warns about anything this package needs that the machine lacks (the `claude` CLI or its login, `openai` credentials, poppler, pandoc, LibreOffice), and a line above the editor lists the workflow commands until the first prompt. To hide pi's list of loaded skills and extensions, set `"quietStartup": "header"` in `~/.pi/agent/settings.json` on each machine. To keep thinking blocks folded until you press `Ctrl+T`, set `"hideThinkingBlock": true` there too; the tool calls already show where the work is heading. Until that key is set, startup warns about it; set it to `false` to keep thinking shown and drop the warning. A folded thinking block draws nothing, not even pi's `Thinking...` line. Collapsed, a bash call shows its command's first line without a leading `cd` into the session's directory; `Ctrl+O` shows it as written.

## Usage

In pi's input box, type a prompt command followed by the task.

```text
/scout-and-plan Investigate the login flow and plan better session-expiry handling
/implement Add a theme option to the config file
/implement-and-review Fix the API response parsing error and review the fix
/deep Make the token bucket rate limiter hold its limit under concurrent requests
```

| Command | Steps | Result |
|---|---|---|
| `/scout-and-plan` | scout → planner → plan-reviewer | Code exploration and a reviewed implementation plan, with no implementation |
| `/implement` | scout → planner → plan-reviewer → worker | Implementation after exploration, planning, and plan review |
| `/implement-and-review` | worker → reviewer → worker | Implementation, review, and fixes for the review's Critical issues |
| `/deep` | deep-worker (→ worker if it escalates) | One logic-heavy goal on GPT-6.1 Sol, handed to the worker when evidence cannot settle a decision |

The prompts use the `subagent` tool's `chain` mode and pass each step's output to the next with `{previous}`. The tool itself supports a single agent (`agent` + `task`), parallel runs (`tasks`), and sequential runs (`chain`). Collapsed, a subagent run is one line per agent: the tool call it is on while it runs, the first line of its answer (or its error) once done, and `waiting` for chain steps not started yet. `Ctrl+O` shows each task, its tool calls and its full output.

### Plan first and handoff

You do not need a command for this. In an interactive session, every request comes with a short note asking the model whether it needs a plan. A quick fix (one change you can state in one sentence, with no design choice) is built directly. Anything else is planned first: the model reads the code, looks up outside docs if it has web search, runs `planner` and `plan-reviewer`, and writes the plan to `docs/plans/<name>.md`: each checkbox step line ends with ``- files: a.ts, b.ts (new) - check: `<command>` ``, and `## Success criteria` has one `` - `<command>` `` line per command. The `handoff` tool refuses a plan until `plan-reviewer` has run in the session, and refuses one not in that format with the problems listed; a plan this session already accepted, or one opened by `/handoff`, is exempt. When the plan touches three or more files, or changes a stored data format or a public interface, pi shows a summary and waits for your go-ahead.

Then the model calls the `handoff` tool, which decides where the build runs:

| Session state | Build runs |
|---|---|
| Context 50% full or more, or compacted at least once | In a new session that starts from the plan file, with the old session as its parent |
| Messy in the model's judgment (it sees the counts of failed tool calls and review `BLOCK`s) | In a new session, when the model asks for one |
| Otherwise | Here, through the `worker` subagent |

While building, the model ticks each step in the plan file, calls `handoff` again between steps so a session that fills up mid-build hands off the rest, and does not finish until every success criteria command passes. A worker's pi has no `handoff` tool, so a worker whose context gets compacted finishes its current step and stops; the main session calls `handoff` again and gives the steps left to a fresh worker. A plan may tag independent, substantial steps that edit separate files as one parallel group. The building session runs the group as one parallel subagent call with a worker per step, then checks and ticks those steps itself, since the workers share one working tree. The review gate also checks ticked steps against the code, and since plans stay out of git, a tick alone counts as a change to review. Before that review, the harness itself runs the check of each step the request ticked, then the success criteria once no step is left; a failing command goes back to the model with the end of its output, to fix the code or untick the step (at most three rounds per request). A plan judges a request while it has steps left, or when that request ticked steps in it. `/handoff <plan>` starts a plan in a new session by hand. Either way, the new session's first message includes the plan's text, so the router picks its tier and thinking effort from the plan rather than from a generic kickoff.

Plan files stay out of git: when pi starts in a repository that does not ignore `docs/plans/` already, it adds that line to `.git/info/exclude`, which is local and never committed.

## Model selection

### Router tiers

| Tier | Model setting | Used for |
|---|---|---|
| `quick` | `pi-claude-cli/claude-sonnet-*` | Questions, explanations, and greetings that ask for no code change |
| `standard` | `pi-claude-cli/claude-opus-*` | Everyday features, bug fixes, reviews, docs |
| `complex` | `pi-claude-cli/claude-opus-*` | Complex design, cross-cutting refactors, hard debugging. **Default fallback** |
| `deep` | `pi-claude-cli/claude-fable-*` | Logic-heavy work such as algorithms, backend internals, and math |
| `complex-high` | `pi-claude-cli/claude-fable-*` | `complex` work rated `xhigh` |

The main session never runs on GPT. Opus is the default; a `quick` question runs on Sonnet at `medium` thinking, and each new user message in that session is classified again, so the session moves to Opus or Fable (and stays there) once a message asks for real work. That move costs one prompt-cache miss. `deep` work runs on Fable, and `complex` work rated very hard (`xhigh`) moves up to Fable. GPT stays in subagents, where a different model family reviews or takes logic-heavy subtasks. The tier still labels the work in the footer and the dataset log. The classifier never picks `complex-high` directly, and an escalated session stays on that model.

A Claude `-*` setting picks the newest numbered version of that family in the registered model catalog. Dated snapshots are excluded, so the actual model version depends on pi's catalog.

The classifier reads up to 16,000 characters of the first user message. When the chosen answer's probability is below `0.5` or the classifier is unreachable, the router uses `complex`. It also uses that tier while Laya is switched off with `/laya off`. This is a **fallback for failed classification**; it does not switch to another provider when the chosen model fails to authenticate or respond.

The same classification also scores how hard the request is from 0 to 3, and the session runs at `low`, `medium`, `high`, or `xhigh` thinking to match; `xhigh` starts at 2.15, since Laya rarely scores above 2.5. A Fable session (`deep` or `complex-high`) runs at `medium` instead, so `xhigh` only reaches a `standard` session. pi's level goes to the `claude` CLI's `--effort` level of the same name for every Claude model. If you pick a thinking level yourself in pi, yours is used for the rest of the session. When the classifier cannot answer, or Laya is off, your level is used from the start.

### Agents

| Agent | Model setting | Role |
|---|---|---|
| `scout` | `pi-claude-cli/claude-haiku:high` | Reads the code and summarizes the relevant files and key context |
| `planner` | `pi-claude-cli/claude-opus:high` | Writes an implementation plan from the exploration and the requirements |
| `plan-reviewer` | `openai/gpt-6.1-sol:xhigh` | Fixes blockers in the plan with a different model family before the worker runs it |
| `worker` | `pi-claude-cli/claude-opus:high` | Implements the assigned task |
| `deep-worker` | `openai/gpt-6.1-sol:medium` | Delivers one logic-heavy goal that tests can settle, or replies `ESCALATE` (oh-my-openagent's deep-low lane) |
| `reviewer` | `openai/gpt-6.1-sol:high` | Reviews code quality and security with a different model family |

The agents' Claude model names are partial names that pi resolves. Set roles and models in the Markdown files in [`agents/`](agents/). The `subagent` tool lists the agents with their `description`, so the main model can delegate on its own, for example a logic-heavy subtask to `deep-worker`; run `/reload` after adding an agent.

The default `agentScope: "user"` loads the package's agents and `~/.pi/agent/agents/`; when names collide, your user agents win. To also use the project's `.pi/agents/`, pass `agentScope: "both"` in the tool call, and project agents take the highest priority. `agentScope: "project"` loads only project agents.

### Review gate

Like the Codex plugin's stop-time review in Claude Code: when a prompt's run changed the repository, the `reviewer` agent reviews those changes before pi stops. It also gets your last three messages (a long one cut to its start and end) and the tool calls the run made with how each ended, so it can check that the changes do what you asked and that a claimed check really ran and passed; this text goes to the `openai` provider. Its first line is `ALLOW` or `BLOCK`, read tolerantly (any case, markdown such as `**BLOCK:**` around it); a review with no verdict line goes to `gpt-6.1-terra` on `openai` to extract one. A `BLOCK` goes back to the model as a message to fix the issue or explain why it is not one, and to write its final reply as the full report on your request, with the fix as a short note at the end. Work from a plan is also checked against the steps the plan ticks. Each prompt gets at most three reviews, and a change after the third shows a warning that it went unreviewed. A failed or timed-out review, or one with no verdict, never blocks: the footer shows `unreviewed` until the next prompt, and the session records the verdict as `NONE`. Only interactive sessions (and print mode under `PI_EVAL=1`) are gated, so subagents never review themselves. While the gate is off, the footer shows `review off`. While a review runs, it shows `reviewing…`; Esc cannot stop it, but it times out after 10 minutes.

| pi command | Action |
|---|---|
| `/review-gate` | Show whether the gate is on |
| `/review-gate on` | Turn the gate on (the default) |
| `/review-gate off` | Turn the gate off for every pi that shares this config directory |

### Timing

While a prompt runs, the footer shows `⏱ 42s · agent 30s · bash 12s`, updated every second: the total so far, the agent time so far, and the top-level tool that has been running longest, while one runs. After the prompt settles, one dim line in the chat sums it up:

```text
⏱ total 1m 23s · agent 58s · bash 41s ×12, subagent 30s ×2, read 2.0s ×5
```

- **total** — wall time from the prompt's start until pi settles, including the review gate, retries and continuations.
- **agent** — the time the agent ran (model and tools), leaving out the review gate and other settle work.
- **tools** — the top three tools by time, with how many calls each made. Calls made by another tool (a codemode script's) are not counted again, and parallel calls overlap, so tool times can add up to more than the total.

An aborted prompt's line ends in `(aborted)`. While a confirm or select prompt waits for you, the total, agent and live tool times keep counting; the summary's tool times do not. Only interactive (tui) sessions are timed, so subagents and print/json mode show nothing. The line is not saved in the session.

### PDF reading

pi's `read` sends a PDF as each page's text layer (`pdftotext -layout`), plus a JPEG, 1,100 px on its long side, of the pages that draw (10 or more vector paths: charts, diagrams, ruled tables), embed a picture, or have under 100 characters of text (scans). For a PDF, `offset` and `limit` count pages: 10 by default, at most 20 per call. Other files go to pi's own `read`.

Text keeps table numbers exact, and an image carries what text cannot, so a page gets an image only when it needs one. Measured on six pages each of a two-column paper, an FOMC projections report, and a scanned paper, with 12 questions per document on prose, tables, and charts, asked through `claude -p` on Opus 5.5 at medium effort, twice or three times each:

| How the PDF is sent | Tokens (paper / report / scan) | Correct |
|---|---|---|
| Text layer only | 15.0K / 4.6K / 0.1K | 34/72: no charts, nothing from the scan |
| Every page as a 100 dpi image (Claude Code's `Read` with `pages`) | 7.5K / 7.5K / 7.8K | 69/72: misreads in dense tables |
| The whole PDF as a document block (Claude Code's `Read` without `pages`) | 24.2K / 13.9K / 9.5K | 72/72 |
| This extension | 19.4K / 11.8K / 7.9K | 108/108 |

### Office file reading

`read` also opens `.docx`, `.xlsx` and `.pptx` (and their macro-enabled `m` versions). Each goes as text where the file's XML holds the answer exactly, and as an image only where text misses it:

- **Word**: pandoc's Markdown (`pandoc -s -t gfm --track-changes=all`), so tracked insertions, deletions and comments show as `<span>` tags, with each embedded picture where it sits and the page header and footer text, which pandoc drops. `offset` and `limit` count lines.
- **Excel**: each sheet as a grid with column letters and row numbers, values as their number format shows them, each formula after its value, and merged ranges. No images: a rendered sheet cuts off narrow columns (`###`) and loses formulas and cell addresses. `offset` and `limit` count lines.
- **PowerPoint**: each slide's titles, text, tables, chart data (from the chart's own XML, so exact even without data labels) and speaker notes, plus a 1,100 px JPEG, rendered through LibreOffice, of each slide with a picture, a connector, a diagram, or a drawn shape that is not a text box. Without LibreOffice those slides come with their embedded pictures only. `offset` and `limit` count slides: 10 by default, at most 20 per call.

Measured on one test document per format, built to hold what each way of sending can lose: a contract with tracked changes, a comment, a merged-cell table, a chart picture and a page header; a budget workbook with formulas, merged headers, a cross-sheet reference and 150 transaction rows; a review deck with charts without data labels, speaker notes, a screenshot, an arrow flowchart, and status shown only by color. Each had 12 questions, asked three times through `claude -p` on Opus 5.5 at medium effort, and graded by Sonnet against an answer key. With one document per format and questions aimed at what each way drops, the table shows what each way misses more than how often.

| How the file is sent | Tokens | Correct | Misses |
|---|---|---|---|
| Word as text only (textutil, markitdown, pandoc's defaults) | 0.3–0.6K | 21/36 | The text before revision, the deleted sentence, the comment, the chart picture, the header |
| Word as page images, or as a rendered PDF through PDF reading | 2.5K / 3.0K | 33/36 | The comment |
| **Word through this extension** | **1.1K** | **36/36** | |
| Excel as CSV or markitdown | 4.3K / 5.7K | 33/36 | Formulas |
| Excel rendered by Numbers or LibreOffice, as page images | 5.7K / 8.8K | 32/36, 30/36 | Formulas, cut-off cells |
| Excel rendered by Numbers or LibreOffice, through PDF reading | 7.7K / 7.2K | 30/36, 24/36 | Formulas, cell addresses, cut-off cells |
| **Excel through this extension** | **6.7K** | **36/36** | |
| PowerPoint as markitdown text | 0.7K | 27/36 | The screenshot, the arrows, the colors |
| PowerPoint as slide images, or as a rendered PDF through PDF reading | 10.4K / 7.9K | 33/36 | Speaker notes |
| PowerPoint through this extension without LibreOffice | 1.1K | 30/36 | The arrows, the colors |
| **PowerPoint through this extension** | **3.5K** | **36/36** | |

### Sandbox

bash runs inside [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) (sandbox-exec on macOS, bubblewrap on Linux). pi's in-process file tools (`read`, `grep`, `find`, `ls`, `write`, `edit`, and `handoff`'s plan read) are checked against the same paths before they run.

- **Writes** go only to the project, the temp dir and `/tmp`. The project is the directory pi runs in, because the runtime protects its always-protected names (`.bashrc`, `.zshrc`, `.gitconfig`, `.git/hooks`, `.git/config`, `.vscode`, `.claude/commands`, and the rest) only at and under that directory, and this package adds the project's `.git/commondir`, `.git/config.worktree`, `.git/modules/` and `.git/worktrees/`, which can point git at a config elsewhere (so bash cannot add submodules or worktrees unless escalated; on Linux, where the runtime's empty stand-in for an absent file would break git, pi first writes a `commondir` of `.`, which git reads as the repository's own dir, and that file is then read-only); a pi started inside `.git`, `.claude`, `.vscode` or `.idea` gets no project. A subagent or other pi without a UI gets its own `cwd` as the project only when that is inside the project of the pi that started it, so its `cwd` can narrow what is writable but never widen it. pi's agent dir (`~/.pi/agent`) is never writable. In the temp dirs bash does not get those protections, so bash can change the hooks of a repository under `/tmp`; pi's file tools refuse the protected names anywhere.
- **Blocked writes, localhost and TLS checks**: when a command fails on a write outside these, on binding localhost, or (macOS) on a TLS certificate check, also when it exits 0 because `… | head` hides the failure, and pi has a UI, pi offers that access, in one dialog per run.
  - Offered: the dirs that cover the path; localhost (`network.allowLocalBinding`, which permits binding and accepting connections on any interface and port, not just localhost, and reaching every localhost service, including proxies or forwarders that can bypass the host allowlist; macOS only, since Linux's sandbox has its own loopback and its runtime ignores the setting); trustd (top-level `enableWeakerNetworkIsolation`, macOS, which Dart and Flutter need to verify TLS certificates; the runtime warns it is a potential data-exfiltration path).
  - A Flutter/Dart trigger (a path in its dirs, Dart's `Failed to create server socket`, or its certificate failure) offers every still-closed part at once: all Flutter/Dart dirs (`~/fvm`, `~/.pub-cache`, `~/.dart-tool`, `~/.dartServer`, `~/.flutter`, `~/.flutter-devtools`, `~/.config/flutter`, `~/Library/Caches/flutter_engine`, minus unsafe or symlinked ones), localhost and trustd. Another trigger offers only its own part: the one tool dir (e.g. `~/.gradle` or `~/Library/Caches/<name>`), or localhost, or trustd. A No sticks for the session; dismissing the dialog does not.
  - Never offered: home itself, `~/.config`, `~/.local`, `~/.claude`, `~/.pi`, `~/.ssh`, `~/.git`, other `~/Library` dirs, a file posing as a dir, a dir overlapping a credential path, or anything outside home.
  - Allow for this session, or always (appended to `sandbox.json`), and the command re-runs inside the sandbox; on Linux a missing dir is created first, since the runtime mounts only existing ones. A command that exited 0 is not re-run (it may only have printed the denial, e.g. `cat` of a log); run it again if it needs the access. No goes on to Escalation, and the same parts are not offered again this session (a dismissed dialog asks again).
  - With no UI, a high-rated command's message carries the `sandbox.json` to paste; so does one that exited 0, without the classifier, saying that a pi with a UI (the parent session) can run the same command to get the dialog.
- **Reads** are open except `~/.ssh` (its `config` and `known_hosts` stay readable), `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.config/gh` and `~/.pi/agent/auth.json`. `grep` over a directory holding one of them is refused too. Credentials elsewhere, or in environment variables, are not protected.
- **Network** reaches `github.com`, `*.github.com`, `*.githubusercontent.com`, `registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org`. Another host is rated by `openai/gpt-6.1-terra` once per session: low (package registries, toolchain downloads, docs the task needs) allows it for the session with a warning; high, or any classifier failure, asks you, and a pi without a UI (subagents, the review gate, `pi -p`) denies it for the session. An allowed host can receive anything a later command can read, project files included. With `PI_SANDBOX_ESCALATE=off` every other host asks you, or is denied with no UI. `SSH_AUTH_SOCK` is reachable on macOS, which alone does not make git over ssh work.
- **Confirmations**: bash with `sudo`, `git … push` or a recursive `rm`, and `write`/`edit` of a file whose name starts with `.env`, ask first; with no UI they are blocked. These match the command text, so they are speed bumps, not a boundary.
- **Escalation**: when a sandboxed bash command fails and shows sandbox-denial evidence (`Operation not permitted`, `EPERM`, a read-only file system, a blocked host, the macOS certificate check `CERTIFICATE_VERIFY_FAILED … application verification failure`), `openai/gpt-6.1-terra` rates running it with no sandbox. Low re-runs the same command outside the sandbox, with a marker line in the output and a warning; high asks you, or with no UI (subagents, the review gate, `pi -p`) is denied and the model is told to ask you. `sudo`, `git push` and `rm -r` always go to you, and a command during which a host was denied (by you, or rated high with no UI), checked again right before the re-run, is never re-run. The command, the denial lines and your last message go to OpenAI. For an unknown host, the host, port, up to 5 running commands (2000 chars each; the runtime does not say which one made the request) and your last message do. No OpenAI auth, and any classifier error or incomplete answer, count as high. A re-run has no sandbox at all (no write limits, no host allowlist, no credential-read denies), and the classifier is a speed bump, not a boundary: prompt injection in the command or its output, or a command that prints fake denial text, can get a command run unsandboxed. A command that partly ran before it was blocked runs a second time. Detection is best-effort: a Java or Gradle error that hides the OS message is not detected and stays a plain failure. `PI_SANDBOX_ESCALATE=off` turns off escalation and the host rating.
- **powershell**: pi's `powershell` tool runs outside the OS sandbox, so it is blocked while the sandbox is on; use bash.

Widen the defaults in `~/.pi/agent/sandbox.json`: lists are appended, single values replace them, and filesystem entries are paths (`~` and relative to the project allowed, globs refused). Besides `filesystem` and `network`, the one top-level key is `enableWeakerNetworkIsolation` (true or false; trustd, above). A malformed file stops the sandbox from starting.

```json
{"filesystem": {"allowWrite": ["~/.npm"]}, "network": {"allowedDomains": ["example.com"]}}
```

Each writable dir you add is one bash can plant code in that runs later outside the sandbox (the dialog says so; a tool cache such as `~/.npm` or `~/.cache` holds code), which is why none is writable by default.

It fails closed: until the sandbox is up, or when it cannot start (sandbox-runtime missing from a local checkout without `npm ci`, ripgrep missing, Linux without bubblewrap or socat), bash and the checked tools are blocked with the reason and the fix; bash never falls back to running unsandboxed. `PI_SANDBOX=off pi` turns both layers off, with a warning at startup.

When the project is this package's own checkout, only its `node_modules/`, `package.json`, `package-lock.json` and `.npmrc` are protected: change dependencies from your own terminal. Its source stays editable, and an edit to it runs unsandboxed on `/reload`, on restart, or at the next subagent's startup; pi warns at startup when the project holds the loaded package. For package code bash cannot change, install from git and work in a separate checkout, or add the checkout to `filesystem.denyWrite`.

Not covered: commands you type with `!` or `!!`; the Claude CLI's own WebSearch and WebFetch; the pi process itself and the extensions it trusts, including a trusted project's `.pi` extensions; the poppler, pandoc and LibreOffice converters `read` runs; and a file changing between a tool's check and its use. If `sandbox.ts` itself fails to load, pi skips it and nothing is sandboxed. Run the sandbox tests (`extensions/sandbox.test.ts`) from a trusted terminal or CI: the real sandbox cannot start inside another one.

## Classifier settings

The default is local Laya. The router points pi's TypeSafe Jev client at the local server, so in both modes the classifier may show up as `typesafe/jev-latest`.

| Env var | Default | Description |
|---|---|---|
| `PI_ROUTER_CLASSIFIER` | `laya` | Local `laya` or TypeSafe `jev` |
| `LAYA_URL` | `http://127.0.0.1:8000/v1` | Laya server URL. The process is managed automatically only when the host is `127.0.0.1` or `localhost` |
| `LAYA_SERVE_BIN` | `laya-serve` | Executable of the server to start automatically |
| `LAYA_MODELS` | `english` | Model setting passed to the Laya server it starts |
| `TYPESAFE_API_KEY` | none | API key for `jev` mode |

To use TypeSafe Jev, set these before starting pi.

```bash
export PI_ROUTER_CLASSIFIER=jev
export TYPESAFE_API_KEY="<your-api-key>"
pi --model router/auto
```

### Laya lifecycle and status

- Starts the local server ahead of time when a `router/auto` session starts or the model is selected.
- Stops a server it started once it has gone 5 minutes unused after classifying, and starts it again when needed.
- Cleans up the server when pi exits or reloads, and a separate lifeline process stops it even if pi exits abnormally.
- Waits up to 30 seconds for startup. The measurements recorded in the code are about 10 s for a cold start and about 2.5 GB of memory; they vary by environment.

| pi command | Action |
|---|---|
| `/laya` | Show the current state |
| `/laya on` | Enable classification and retry starting the server |
| `/laya off` | Disable classification and stop local Laya |

By default the switch is saved in `~/.pi/agent/laya.json` and applies to every pi instance that uses the same config directory. Setting `PI_CODING_AGENT_DIR` moves it too. A session that is already routed keeps its tier, so check changed classification behavior in a new session.

The footer shows `laya starting`, `laya on`, `laya idle`, `laya unavailable`, or `laya off`. `/laya off` can also stop a `laya-serve` on that local port that another pi started or that you started by hand.

### Dataset log

Each newly routed session appends one JSON line to `~/.pi/agent/laya-dataset.jsonl` (it follows `PI_CODING_AGENT_DIR`): the prompt Laya saw (up to 16,000 characters), every tier's probability, the raw effort score, and the tier, model, and thinking level used. Sessions routed while Laya is off are logged without answers. `session` matches the pi session file, whose `thinking_level_change` and `model_change` entries show where you overrode the route. The file holds prompt text, so treat it like your session files.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `laya unavailable` or a server start warning | Check the `laya[serve]` install and the `LAYA_SERVE_BIN` path, then run `/laya on` |
| You want to keep working without Laya | Run `/laya off`. New sessions route to Opus |
| The `pi-claude-cli` provider fails to load | Check that `claude` is on your PATH and that `claude auth login` is done |
| `is not in the model catalog` | Check that the chosen provider is loaded and check pi's model catalog |
| Auth errors in `deep-worker`, a review step, or the review gate | Check the `openai` provider's authentication and your access to the model |
| A project agent is not picked up | Check that you pass `agentScope: "both"` or `"project"` |
| `pdfinfo not found` when reading a PDF | Install poppler: `brew install poppler`, or `apt-get install poppler-utils` |
| `pandoc not found` when reading a .docx | Install pandoc: `brew install pandoc`, or `apt-get install pandoc` |
| A .pptx read says LibreOffice could not render the slides | Install LibreOffice: `brew install --cask libreoffice`. Until then, those slides come with their embedded pictures only |

Claude requests run through `claude -p`, so Claude Code's user settings, hooks, and plugins can affect them. Its MCP servers and its built-in tools are left out, except web search and fetch; pi's own tools reach Claude through an MCP server, and one `claude` process keeps the conversation between turns. Keep credentials and per-machine UI settings in each machine's pi and Claude config, not in this repository.

## Repository layout

```text
agents/                     Role prompts and model settings
prompts/                    Workflow templates for slash commands
extensions/
  router.ts                 router/auto and Laya process management
  router.test.ts            Router tests
  sandbox.ts                OS sandbox for bash, and the same path checks for pi's file tools
  footer.ts                 Two-line footer with the routed tier and model
  review-gate.ts            Stop-time review of each prompt's changes
  handoff.ts                Plan-first note, the handoff tool, and /handoff
  checks.ts                 The plan step format: parse, lint, and run a check
  pdf-read.ts               read for PDFs: page text plus images where needed
  office-read.ts            read for .docx, .xlsx and .pptx: text plus images where needed
  tab-follow-up.ts          Tab queues a follow-up while the agent runs
  timing.ts                 Live prompt timer in the footer and a timing line after each prompt
  test-hooks.ts             Loads pi's packages in tests the way pi does
  subagent/                 Subagent runs and agent discovery
  pi-claude-cli/            Claude CLI provider
docs/images/                README diagram and GitHub social preview image
bench/agent/                Agent eval set: pass and false-done rates per model
```

## Tests

Run from the repository root with Node.js 22.18 or later and pi installed.

```bash
npm test
```

The tests cover the router's classification, fallback, model selection, and process lifetime; the subagent tool's agent loading and chain runs; the review gate's change detection, verdicts, and plan checks; the handoff's session signals, its stay-or-leave decision and new session, and keeping plan files out of git; which PDF pages `read` sends with an image, and its page ranges; how it sends Word tracked changes, Excel cells and formulas, and PowerPoint chart data, notes and pictures; and the Claude CLI provider's system prompt handoff, tool calls, and CLI error handling. pi's packages load from the installed pi (`~/.pi/agent/install`), and fake processes stand in for `pi` and `claude`. Real provider authentication and full workflow runs need to be checked separately.

GitHub Actions runs the same tests on every push and PR, and weekly against the newest pi from npm, so a pi update that breaks this package shows up right away.

### Eval set

`PI_EVAL=1` gates print mode (`pi -p`) like an interactive session: the plan-first note, `handoff` (which then never moves the build to a new session), plan checks and the review gate. Subagents run in json mode and are never gated. `bench/agent/` holds eight tasks that measure pass rate and false-done rate per model, with the gate and without:

```bash
node --import ./extensions/test-hooks.ts bench/agent/run.ts --dry
```

`--dry` checks the fixtures with no model calls, but it needs the installed pi, since it loads pi's packages through `test-hooks.ts`. Real runs are manual and billed, and a gate run needs `/review-gate on`; see `bench/agent/README.md`.

## License and attribution

[MIT](LICENSE). The `subagent` extension comes from pi's examples and is modified to load the agents in this package. The Claude CLI provider is `pi-claude-cli` 0.3.1, modified for pi 0.99, and includes its [MIT license](extensions/pi-claude-cli/LICENSE).
