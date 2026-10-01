# pi-halfmoon-setup

**English** | [한국어](README.ko.md)

[![test](https://github.com/halfmoon-mind/pi-halfmoon-setup/actions/workflows/test.yml/badge.svg)](https://github.com/halfmoon-mind/pi-halfmoon-setup/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A personal [pi](https://pi.dev) package that picks a model from the first request and splits work across role-based agents.**

Use the same model router, subagents, and workflow prompts on every machine. `router/auto` classifies the first user message once and keeps the chosen tier for the whole session, so repeated model switches never break the prompt cache.

![Diagram of a router that classifies the first request into Sonnet, Opus, or GPT, and of the scout, planner, worker, and reviewer roles](docs/images/overview.svg)

## Features

- **Per-session routing** — assigns different models to everyday work, complex design, and logic-heavy problems.
- **Role-based subagents** — explore, plan, implement, and review in isolated contexts.
- **Workflow commands** — chain work with `/implement`, `/scout-and-plan`, and `/implement-and-review`.
- **Claude CLI provider** — uses your logged-in `claude` CLI as a pi model provider.
- **Optional local classifier** — starts and stops Laya automatically, and falls back to Opus when it cannot classify.

## Quick start

### 1. Prerequisites and install

`pi` and Claude Code's `claude` command must be on your PATH. This repository is not a standalone app; it is a package that pi loads.

```bash
pi install git:github.com/halfmoon-mind/pi-halfmoon-setup
claude auth login
```

To use a local checkout instead, install it like this. After editing, run `/reload` in pi to load the changes.

```bash
pi install ~/projects/pi-halfmoon-setup
```

The `deep` tier and the `reviewer` agent use the `openai` provider, so set up its authentication too. With an environment variable:

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

## Usage

In pi's input box, type a prompt command followed by the task.

```text
/scout-and-plan Investigate the login flow and plan better session-expiry handling
/implement Add a theme option to the config file
/implement-and-review Fix the API response parsing error and review the fix
```

| Command | Steps | Result |
|---|---|---|
| `/scout-and-plan` | scout → planner | Code exploration and an implementation plan, with no implementation |
| `/implement` | scout → planner → worker | Implementation after exploration and planning |
| `/implement-and-review` | worker → reviewer → worker | Implementation, review, and the review's feedback applied |

The prompts use the `subagent` tool's `chain` mode and pass each step's output to the next with `{previous}`. The tool itself supports a single agent (`agent` + `task`), parallel runs (`tasks`), and sequential runs (`chain`).

## Model selection

### Router tiers

| Tier | Model setting | Used for |
|---|---|---|
| `standard` | `pi-claude-cli/claude-sonnet-*` | Everyday features, bug fixes, reviews, docs, questions |
| `complex` | `pi-claude-cli/claude-opus-*` | Complex design, cross-cutting refactors, hard debugging. **Default fallback** |
| `deep` | `openai/gpt-6.1-sol` | Logic-heavy work such as algorithms, backend internals, and math |

A Claude `-*` setting picks the newest numbered version of that family in the registered model catalog. Dated snapshots are excluded, so the actual model version depends on pi's catalog.

The classifier reads up to 16,000 characters of the first user message. When the chosen answer's probability is below `0.5` or the classifier is unreachable, the router uses `complex`. It also uses that tier while Laya is switched off with `/laya off`. This is a **fallback for failed classification**; it does not switch to another provider when the chosen model fails to authenticate or respond.

### Agents

| Agent | Model setting | Role |
|---|---|---|
| `scout` | `pi-claude-cli/claude-haiku` | Reads the code and summarizes the relevant files and key context |
| `planner` | `pi-claude-cli/claude-opus` | Writes an implementation plan from the exploration and the requirements |
| `worker` | `router/auto` | Classifies the assigned task and implements it |
| `reviewer` | `openai/gpt-6-astra:high` | Reviews code quality and security with a different model family |

The agents' Claude model names are partial names that pi resolves. Set roles and models in the Markdown files in [`agents/`](agents/).

The default `agentScope: "user"` loads the package's agents and `~/.pi/agent/agents/`; when names collide, your user agents win. To also use the project's `.pi/agents/`, pass `agentScope: "both"` in the tool call, and project agents take the highest priority. `agentScope: "project"` loads only project agents.

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

## Troubleshooting

| Symptom | What to check |
|---|---|
| `laya unavailable` or a server start warning | Check the `laya[serve]` install and the `LAYA_SERVE_BIN` path, then run `/laya on` |
| You want to keep working without Laya | Run `/laya off`. New sessions route to Opus |
| The `pi-claude-cli` provider fails to load | Check that `claude` is on your PATH and that `claude auth login` is done |
| `is not in the model catalog` | Check that the chosen provider is loaded and check pi's model catalog |
| Auth errors in the `deep` tier or the review step | Check the `openai` provider's authentication and your access to the model |
| A project agent is not picked up | Check that you pass `agentScope: "both"` or `"project"` |

Claude requests run through `claude -p`, so Claude Code's user settings, hooks, and plugins can affect them. Its MCP servers and its built-in tools are left out, except web search and fetch; pi's own tools reach Claude through an MCP server, and one `claude` process keeps the conversation between turns. Keep credentials and per-machine UI settings in each machine's pi and Claude config, not in this repository.

## Repository layout

```text
agents/                     Role prompts and model settings
prompts/                    Workflow templates for slash commands
extensions/
  router.ts                 router/auto and Laya process management
  router.test.ts            Router tests
  footer.ts                 Two-line footer with the routed tier and model
  test-hooks.ts             Loads pi's packages in tests the way pi does
  subagent/                 Subagent runs and agent discovery
  pi-claude-cli/            Claude CLI provider
docs/images/                README diagram and GitHub social preview image
```

## Tests

Run from the repository root with Node.js 22.18 or later and pi installed.

```bash
npm test
```

The tests cover the router's classification, fallback, model selection, and process lifetime; the subagent tool's agent loading and chain runs; and the Claude CLI provider's system prompt handoff, tool calls, and CLI error handling. pi's packages load from the installed pi (`~/.pi/agent/install`), and fake processes stand in for `pi` and `claude`. Real provider authentication and full workflow runs need to be checked separately.

GitHub Actions runs the same tests on every push and PR, and weekly against the newest pi from npm, so a pi update that breaks this package shows up right away.

## License and attribution

[MIT](LICENSE). The `subagent` extension comes from pi's examples and is modified to load the agents in this package. The Claude CLI provider is `pi-claude-cli` 0.3.1, modified for pi 0.99, and includes its [MIT license](extensions/pi-claude-cli/LICENSE).
