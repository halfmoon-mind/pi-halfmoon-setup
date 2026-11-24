# 라우팅

[English](routing.md) | **한국어**

## 라우터 티어

| 티어 | 모델 설정 | 대상 작업 |
|---|---|---|
| `quick` | `pi-claude-cli/claude-sonnet-*` | 코드 변경 없는 질문, 설명, 인사 |
| `standard` | `pi-claude-cli/claude-opus-*` | 일반 기능 개발, 버그 수정, 리뷰, 문서 |
| `complex` | `pi-claude-cli/claude-opus-*` | 복잡한 설계, 여러 영역의 리팩터링, 어려운 디버깅. **기본 폴백** |
| `deep` | `pi-claude-cli/claude-fable-*` | 알고리즘, 백엔드 내부 구조, 수학 등 논리 중심 작업 |
| `complex-high` | `pi-claude-cli/claude-fable-*` | 난이도가 `xhigh`인 `complex` 작업 |

메인 세션은 GPT를 쓰지 않습니다. Opus가 기본이며, `quick` 질문은 Sonnet에서 `medium` thinking으로 돕니다. 이 세션은 새 사용자 메시지마다 다시 분류해, 실제 작업을 요청하는 메시지가 오면 Opus나 Fable로 옮겨 그대로 유지합니다. 이때 프롬프트 캐시가 한 번 깨집니다. 그 밖에 `deep` 작업은 Fable에서 돌고, 매우 어렵다(`xhigh`)고 판단한 `complex` 작업도 Fable로 올라갑니다. GPT는 다른 모델 계열로 리뷰하거나 논리 중심 하위 작업을 맡는 서브에이전트에만 씁니다. 티어는 푸터와 데이터셋 로그에서 작업 종류를 나타내는 데 계속 쓰입니다. 분류기가 `complex-high`를 직접 고르지는 않으며, 올라간 세션은 끝까지 그 모델을 유지합니다.

Claude의 `-*` 설정은 등록된 모델 카탈로그에서 해당 계열의 최신 숫자 버전을 선택합니다. 날짜가 붙은 스냅샷은 제외하므로, 실제 모델 버전은 pi의 카탈로그에 따라 달라집니다.

Claude Haiku가 pi-claude-cli와 같은 로그인으로 `claude -p`를 통해 분류하므로 구독 한도에서 차감됩니다. 분류에는 약 4초(p50 3.8초)가 걸리며, 사용자 메시지의 최대 16,000자를 사용합니다. `claude`가 없거나, 오류가 나거나, 30초 안에 답하지 않거나, 스키마 밖의 답을 주면 `complex`를 사용하며, quick 세션에서 이렇게 되면 그 뒤로 `complex`에 머물릅니다. 이는 **분류 실패에 대한 폴백**이며, 선택된 모델의 인증·호출 실패 시 다른 프로바이더로 전환하는 기능은 아닙니다.

같은 분류에서 thinking level도 `low`, `medium`, `high`, `xhigh` 중 하나로 고릅니다. `standard`와 `complex`는 그 값을 쓰고, `quick`과 Fable 티어(`deep`, `complex-high`)는 `medium`을 쓰므로 `xhigh`는 `standard` 세션에만 적용됩니다. pi의 레벨은 모든 Claude 모델에서 `claude` CLI의 같은 이름 `--effort` 레벨로 전달됩니다. pi에서 thinking level을 직접 바꾸면 그 세션의 나머지 동안은 사용자가 고른 값을 씁니다. 단, 분류할 때 pi에 설정돼 있던 레벨을 다시 고르면 알아채지 못해 라우팅된 레벨이 그대로 남습니다. 분류기가 답하지 못하면 처음부터 사용자가 정한 값을 씁니다.

## 분류기

라우터는 다음 명령을 실행하고 `.structured_output`에서 티어와 effort를 읽습니다.

```bash
claude -p --model haiku --output-format json --json-schema <SCHEMA> --no-session-persistence --tools "" --setting-sources= --strict-mcp-config --disable-slash-commands --system-prompt <SYSTEM>
```

`--tools ""`는 뒤에 오는 위치 인자를 자신의 값으로 가져가므로, 프롬프트는 stdin으로 전달합니다. `--bare`는 쓰지 않습니다. OAuth와 키체인을 끄기 때문에 구독 로그인으로는 답할 수 없게 됩니다. `--setting-sources=`로 사용자의 hook과 CLAUDE.md가 Haiku에 전달되지 않게 합니다.

설정은 없습니다. 라우팅을 건너뛰려면 `/model`로 모델을 직접 고르세요.

직접 라벨링한 30개의 검증용 프롬프트에서 Haiku는 28개, 이전 로컬 분류기는 18개를 맞혔습니다. 실제 작업 요청 20개 중 `quick`으로 보낸 것은 Haiku 0개, 이전 분류기 6개였습니다. Haiku의 p50 지연은 3.8초였습니다.

## 데이터셋 로그

새로 라우팅된 세션마다, quick 세션은 quick을 벗어날 때까지 분류한 메시지마다 `~/.pi/agent/laya-dataset.jsonl`에 JSON 한 줄이 추가됩니다(`PI_CODING_AGENT_DIR`을 따름). `time`, `mode`, Haiku가 본 프롬프트(최대 16,000자), `classifier`, 실제 사용한 티어·모델·thinking 레벨, 남아 있으면 `effort`와 `userLevel`(분류할 때의 사용자 레벨), 분류 실패 시 `unclassified`가 기록되며, 확률이나 점수는 없습니다. `session`은 pi 세션 파일과 같은 값이며, 그 파일의 `thinking_level_change`, `model_change` 항목으로 사용자가 라우팅을 바꾼 지점을 알 수 있습니다. 프롬프트 원문이 담기므로 세션 파일처럼 다루세요.

파일 이름 `laya-dataset.jsonl`은 이전 로컬 분류기(Laya)에서 이어진 것으로, Laya는 `/laya`, `laya.json`, `PI_ROUTER_CLASSIFIER`, `LAYA_*` 변수와 함께 제거되었습니다. 이후 기록된 줄에는 `"classifier": "haiku"`가 있고 `probabilities`나 `score`는 없습니다.
