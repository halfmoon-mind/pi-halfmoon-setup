# Routing

**English** | [한국어](routing.ko.md)

## Router tiers

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

## Laya lifecycle and status

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

## Dataset log

Each newly routed session appends one JSON line to `~/.pi/agent/laya-dataset.jsonl` (it follows `PI_CODING_AGENT_DIR`): the prompt Laya saw (up to 16,000 characters), every tier's probability, the raw effort score, and the tier, model, and thinking level used. Sessions routed while Laya is off are logged without answers. `session` matches the pi session file, whose `thinking_level_change` and `model_change` entries show where you overrode the route. The file holds prompt text, so treat it like your session files.
