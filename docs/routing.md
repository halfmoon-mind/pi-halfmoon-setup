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

Claude Haiku classifies through `claude -p` with the same login as pi-claude-cli, so it counts against your subscription limits. It takes about 4 s (p50 3.8 s) and reads up to 16,000 characters of the user message. A missing `claude`, an error, a 30 s timeout, or an answer outside the schema makes the router use `complex`, and a quick session that hits one stays on `complex` for good. This is a **fallback for failed classification**; it does not switch to another provider when the chosen model fails to authenticate or respond.

The same classification picks the thinking level, `low`, `medium`, `high`, or `xhigh`; `standard` and `complex` use it, while `quick` and the Fable tiers (`deep` and `complex-high`) use `medium`, so `xhigh` only reaches a `standard` session. pi's level goes to the `claude` CLI's `--effort` level of the same name for every Claude model. If you pick a thinking level yourself in pi, yours is used for the rest of the session. Picking the level pi was set to when the session was classified is not noticed, so the routed level stays. When the classifier cannot answer, your level is used from the start.

## Classifier

The router runs:

```bash
claude -p --model haiku --output-format json --json-schema <SCHEMA> --no-session-persistence --tools "" --setting-sources= --strict-mcp-config --disable-slash-commands --system-prompt <SYSTEM>
```

and reads the tier and effort from `.structured_output`. The prompt goes on stdin, because `--tools ""` would take a positional argument after it as its own value. There is no `--bare`: it turns off OAuth and the keychain, so a subscription login could not answer. `--setting-sources=` keeps your hooks and CLAUDE.md away from Haiku.

There are no settings. To skip routing, pick a model with `/model`.

On 30 held-out hand-labelled prompts, Haiku got 28 right against 18 for the previous local classifier, and sent 0 of 20 real work requests to `quick` against its 6 of 20. Haiku's p50 latency was 3.8 s.

## Dataset log

Each newly routed session appends one JSON line, and a quick session one per classified message until it leaves quick, to `~/.pi/agent/laya-dataset.jsonl` (it follows `PI_CODING_AGENT_DIR`): `time`, `mode`, the prompt Haiku saw (up to 16,000 characters), `classifier`, the tier, model and thinking level used, `effort` and `userLevel` (your level when it was classified) when kept, and `unclassified` when the classifier failed, with no probabilities or score. `session` matches the pi session file, whose `thinking_level_change` and `model_change` entries show where you overrode the route. The file holds prompt text, so treat it like your session files.

The file keeps the name `laya-dataset.jsonl` from the earlier local classifier (Laya), removed together with `/laya`, `laya.json`, `PI_ROUTER_CLASSIFIER` and the `LAYA_*` variables; lines written since carry `"classifier": "haiku"` and no `probabilities` or `score`.
