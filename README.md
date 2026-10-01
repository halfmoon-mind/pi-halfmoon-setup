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
| `standard` | `pi-claude-cli/claude-sonnet-*`: the newest Sonnet in pi's model catalog (now 5.5) | Ordinary features, fixes, reviews, docs, questions |
| `complex` | `pi-claude-cli/claude-opus-*`: the newest Opus in pi's model catalog (now 5.5) | Subtle design, cross-cutting refactors, hard debugging. **Also the fallback.** |
| `deep` | `openai/gpt-6.1-sol` | Logic-heavy algorithms, backend internals, math |

The router uses the fallback tier when the classifier is unreachable (with a one-time warning), when the top answer's probability is below 0.5, or, without a warning, while laya is switched off with `/laya off`.

### Agents

| Agent | Model | Role |
|---|---|---|
| `scout` | `pi-claude-cli/claude-haiku`: pi picks the newest Haiku for a partial name (now 4.5) | Fast read-only recon |
| `planner` | `pi-claude-cli/claude-opus`: pi picks the newest Opus for a partial name (now 5.5) | Implementation plans |
| `reviewer` | `openai/gpt-6-astra:high` | Code review by a different model family |
| `worker` | `router/auto` | General work, with the model picked by classifying the task |

The tier and agent choices follow the role split in oh-my-openagent's [agent-model-matching guide](https://github.com/code-yeongyu/oh-my-openagent/blob/HEAD/docs/guide/agent-model-matching.md).

## Install

1. Install the package.

   ```bash
   pi install git:github.com/halfmoon-mind/pi-halfmoon-setup
   # or a local checkout, where edits apply on /reload:
   pi install ~/projects/pi-halfmoon-setup
   ```

2. Log in to the model providers.
   - Claude: install [Claude Code](https://code.claude.com) and run `claude auth login`. The `pi-claude-cli` provider runs the `claude` CLI, so without it the `standard` and `complex` tiers and the `scout` and `planner` agents fail.
   - OpenAI: run `/login` in pi and pick OpenAI.

3. Install laya, the local classifier (optional, see [Without laya](#without-laya)). It needs Python 3.10 or later; the model download is a few MB.

   ```bash
   pip install "laya[serve]"
   # If laya-serve is not on PATH, for example inside a venv, add this to ~/.zshrc:
   export LAYA_SERVE_BIN=~/projects/laya/.venv/bin/laya-serve
   ```

4. Start pi with `pi --model router/auto`, or pick `router/auto` with `/model`. The footer shows `laya on` once the classifier is ready, and `/laya` shows its state.

### Without laya

The package works without laya; nothing fails to load. `router/auto` skips classification and uses the `complex` tier (the newest Opus), and the first `router/auto` session shows one warning that repeats the steps above. To choose:

- Install laya later (step 3), then run `/laya on`, or restart pi after changing `LAYA_SERVE_BIN`.
- Run `/laya off` to always use the newest Opus and hide the warning.
- Classify with TypeSafe Jev instead, which needs no local server: `export PI_ROUTER_CLASSIFIER=jev TYPESAFE_API_KEY=...`.

## Classifier

By default, the router classifies with a local [Laya](https://github.com/NandhaKishorM/laya) server. Laya speaks the same System One protocol as TypeSafe Jev, so the router reuses pi's built-in Jev client and points it at the local server.

pi starts and stops laya-serve itself when `LAYA_URL` is local (install it with [Install](#install) step 3):

- A `router/auto` session starts laya ahead of its first message (cold start is about 5 to 10 s), and the footer shows `laya starting`, `laya on`, `laya idle`, `laya unavailable` (not installed), or `laya off`.
- laya holds about 2.5 GB while running, so pi stops it after 5 minutes unused and starts it again when a new session needs it.
- laya never outlives the pi that started it: closing pi or the terminal stops it, and a lifeline process stops it even if pi crashes or is killed.
- `/laya` shows the state. `/laya off` stops laya and makes `router/auto` use the newest Opus without classifying; `/laya on` turns it back on. The switch is saved in `~/.pi/agent/laya.json` and applies to every pi.

| Env var | Default | Meaning |
|---|---|---|
| `PI_ROUTER_CLASSIFIER` | `laya` | `laya` for the local server, `jev` for TypeSafe Jev (needs `TYPESAFE_API_KEY`) |
| `LAYA_URL` | `http://127.0.0.1:8000/v1` | laya-serve base URL. pi manages laya only when this is `127.0.0.1` or `localhost`. |
| `LAYA_SERVE_BIN` | `laya-serve` | laya-serve executable that pi starts |

The footer and `/session` show the classifier as `typesafe/jev-latest` in both modes.

## Test

```bash
node --test extensions/router.test.ts
```

## Notes

- Claude models use the `pi-claude-cli` provider, which runs the logged-in `claude` CLI (`claude -p`), so they draw on the subscription's usage limits. pi's built-in `anthropic` provider draws on the account's **extra usage** instead; once that runs out, requests fail with `You're out of extra usage` (HTTP 400).
- `claude -p` loads your Claude Code setup (`~/.claude/CLAUDE.md`, hooks, plugins, MCP servers) on every request.
- Settings that cannot live in a package stay in `~/.pi/agent/settings.json`: credentials, global UI settings, and keybinding overrides.
