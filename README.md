# pi-halfmoon-setup

A [pi](https://pi.dev) package with a model router and role-based subagents, shared across machines.

## Contents

| Path | What it does |
|---|---|
| `extensions/router.ts` | `router/auto` virtual model. Classifies the first user message **once**, then keeps that model for the whole session, so routing never invalidates the prompt cache. |
| `extensions/subagent/` | `subagent` tool, vendored from pi's example extension. Also loads the agents in this package. |
| `agents/` | Role → model assignments (see below). A user agent (`~/.pi/agent/agents`) or project agent (`.pi/agents`) with the same name overrides one of these. |
| `prompts/` | `/implement`, `/scout-and-plan`, `/implement-and-review` workflow prompts for the subagent tool. |

### Router tiers

| Tier | Model | Picked for |
|---|---|---|
| `standard` | `anthropic/claude-sonnet-5-5` | Ordinary features, fixes, reviews, docs, questions |
| `complex` | `anthropic/claude-opus-5-5` | Subtle design, cross-cutting refactors, hard debugging. **Also the fallback.** |
| `deep` | `openai/gpt-6.1-sol` | Logic-heavy algorithms, backend internals, math |

The router uses the fallback tier when the classifier is unreachable (with a one-time warning) or when the top answer's probability is below 0.5.

### Agents

| Agent | Model | Role |
|---|---|---|
| `scout` | `anthropic/claude-haiku-4-5` | Fast read-only recon |
| `planner` | `anthropic/claude-opus-5-5` | Implementation plans |
| `reviewer` | `openai/gpt-6-astra:high` | Code review by a different model family |
| `worker` | `router/auto` | General work, with the model picked by classifying the task |

The tier and agent choices follow the role split in oh-my-openagent's [agent-model-matching guide](https://github.com/code-yeongyu/oh-my-openagent/blob/HEAD/docs/guide/agent-model-matching.md).

## Install

```bash
pi install ~/projects/pi-halfmoon-setup          # local checkout; edits apply on /reload
# or, on another machine:
pi install git:github.com/halfmoon-mind/pi-halfmoon-setup
```

Log in to both providers with `/login` (Anthropic and OpenAI). Then select `router/auto` with `/model`, or start pi with `pi --model router/auto`.

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

- Using an Anthropic subscription in pi draws on the account's **extra usage**. Once extra usage runs out, requests fail with `You're out of extra usage` (HTTP 400).
- Settings that cannot live in a package stay in `~/.pi/agent/settings.json`: credentials, global UI settings, and keybinding overrides.
