# pi-halfmoon-setup

A [pi](https://pi.dev) package with a model router and role-based subagents, shared across machines.

## Contents

| Path | What it does |
|---|---|
| `extensions/router.ts` | `router/auto` virtual model. Classifies the first user message **once**, then keeps that model for the whole session, so routing never invalidates the prompt cache. |
| `extensions/subagent/` | `subagent` tool, vendored from pi's example extension. Also loads the agents in this package. |
| `extensions/pi-claude-cli/` | `pi-claude-cli` provider: runs Claude models through the logged-in `claude` CLI. Vendored from [pi-claude-cli](https://github.com/rchern/pi-claude-cli) 0.3.1 (MIT) and patched for pi 0.99. |
| `agents/` | Role → model assignments (see below). A user agent (`~/.pi/agent/agents`) or project agent (`.pi/agents`) with the same name overrides one of these. |
| `prompts/` | `/implement`, `/scout-and-plan`, `/implement-and-review` workflow prompts for the subagent tool. |

### Router tiers

| Tier | Model | Picked for |
|---|---|---|
| `standard` | `pi-claude-cli/claude-sonnet-5-5` | Ordinary features, fixes, reviews, docs, questions |
| `complex` | `pi-claude-cli/claude-opus-5-5` | Subtle design, cross-cutting refactors, hard debugging. **Also the fallback.** |
| `deep` | `openai/gpt-6.1-sol` | Logic-heavy algorithms, backend internals, math |

The router uses the fallback tier when the classifier is unreachable (with a one-time warning) or when the top answer's probability is below 0.5.

### Agents

| Agent | Model | Role |
|---|---|---|
| `scout` | `pi-claude-cli/claude-haiku-4-5` | Fast read-only recon |
| `planner` | `pi-claude-cli/claude-opus-5-5` | Implementation plans |
| `reviewer` | `openai/gpt-6-astra:high` | Code review by a different model family |
| `worker` | `router/auto` | General work, with the model picked by classifying the task |

The tier and agent choices follow the role split in oh-my-openagent's [agent-model-matching guide](https://github.com/code-yeongyu/oh-my-openagent/blob/HEAD/docs/guide/agent-model-matching.md).

## Install

```bash
pi install ~/projects/pi-halfmoon-setup          # local checkout; edits apply on /reload
# or, on another machine:
pi install git:github.com/halfmoon-mind/pi-halfmoon-setup
```

Log in to Claude Code with `claude auth login` (Claude models) and to OpenAI with `/login`. Then select `router/auto` with `/model`, or start pi with `pi --model router/auto`.

## Classifier

By default, the router classifies with a local [Laya](https://github.com/NandhaKishorM/laya) server. Laya speaks the same System One protocol as TypeSafe Jev, so the router reuses pi's built-in Jev client and points it at the local server.

```bash
# one-time: pip install "laya[serve]"
LAYA_HOST=127.0.0.1 LAYA_MODELS=english laya-serve      # http://127.0.0.1:8000
```

| Env var | Default | Meaning |
|---|---|---|
| `PI_ROUTER_CLASSIFIER` | `laya` | `laya` for the local server, `jev` for TypeSafe Jev (needs `TYPESAFE_API_KEY`) |
| `LAYA_URL` | `http://127.0.0.1:8000/v1` | laya-serve base URL |

The footer and `/session` show the classifier as `typesafe/jev-latest` in both modes.

## Test

```bash
node --test extensions/router.test.ts
```

## Notes

- Claude models use the `pi-claude-cli` provider, which runs the logged-in `claude` CLI (`claude -p`), so they draw on the subscription's usage limits. pi's built-in `anthropic` provider draws on the account's **extra usage** instead; once that runs out, requests fail with `You're out of extra usage` (HTTP 400).
- `claude -p` loads your Claude Code setup (`~/.claude/CLAUDE.md`, hooks, plugins, MCP servers) on every request.
- Settings that cannot live in a package stay in `~/.pi/agent/settings.json`: credentials, global UI settings, and keybinding overrides.
