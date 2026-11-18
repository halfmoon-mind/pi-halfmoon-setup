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

분류기는 첫 사용자 메시지의 최대 16,000자를 사용합니다. 선택된 답의 확률이 `0.5` 미만이거나 분류기에 접근할 수 없으면 `complex`를 사용합니다. `/laya off` 상태에서도 같은 티어를 사용합니다. 이는 **분류 실패에 대한 폴백**이며, 선택된 모델의 인증·호출 실패 시 다른 프로바이더로 전환하는 기능은 아닙니다.

같은 분류에서 요청의 난이도도 0~3점으로 함께 매겨, 세션의 thinking level을 `low`, `medium`, `high`, `xhigh` 중 하나로 정합니다. Laya가 2.5를 넘는 점수를 거의 주지 않아 `xhigh`는 2.15점부터입니다. Fable 세션(`deep`, `complex-high`)은 대신 `medium`으로 돌기 때문에, `xhigh`는 `standard` 세션에만 적용됩니다. pi의 레벨은 모든 Claude 모델에서 `claude` CLI의 같은 이름 `--effort` 레벨로 전달됩니다. pi에서 thinking level을 직접 바꾸면 그 세션의 나머지 동안은 사용자가 고른 값을 씁니다. 분류기가 답하지 못하거나 Laya가 꺼져 있으면 처음부터 사용자가 정한 값을 씁니다.

## 분류기 설정

기본값은 로컬 Laya입니다. pi의 TypeSafe Jev 클라이언트를 로컬 서버에 연결하므로 두 모드 모두 분류기 식별자가 `typesafe/jev-latest`로 표시될 수 있습니다.

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `PI_ROUTER_CLASSIFIER` | `laya` | 로컬 `laya` 또는 TypeSafe `jev` |
| `LAYA_URL` | `http://127.0.0.1:8000/v1` | Laya 서버 주소. 호스트가 `127.0.0.1` 또는 `localhost`일 때만 프로세스를 자동 관리 |
| `LAYA_SERVE_BIN` | `laya-serve` | 자동 실행할 서버의 실행 파일 경로 |
| `LAYA_MODELS` | `english` | 자동 시작하는 Laya 서버에 전달할 모델 설정 |
| `TYPESAFE_API_KEY` | 없음 | `jev` 모드에서 사용할 API 키 |

TypeSafe Jev를 사용하려면 pi를 시작하기 전에 설정합니다.

```bash
export PI_ROUTER_CLASSIFIER=jev
export TYPESAFE_API_KEY="<your-api-key>"
pi --model router/auto
```

## Laya 수명과 상태

- `router/auto` 세션 시작 또는 모델 선택 시 로컬 서버를 미리 시작합니다.
- 분류 이후 5분 동안 사용하지 않으면 자신이 시작한 서버를 종료하고, 필요할 때 다시 시작합니다.
- pi 종료·리로드 시 서버를 정리하며, 별도 lifeline 프로세스가 비정상 종료 시에도 서버를 종료하도록 구성되어 있습니다.
- 시작 대기 제한은 30초입니다. 코드에 기록된 측정치는 콜드 스타트 약 10초, 메모리 약 2.5GB이며 환경에 따라 달라집니다.

| pi 명령어 | 동작 |
|---|---|
| `/laya` | 현재 상태 표시 |
| `/laya on` | 분류 활성화 및 서버 시작 재시도 |
| `/laya off` | 분류 비활성화 및 로컬 Laya 종료 |

스위치는 기본적으로 `~/.pi/agent/laya.json`에 저장되어 같은 설정 디렉터리를 사용하는 pi 인스턴스에 적용됩니다. `PI_CODING_AGENT_DIR`을 설정하면 저장 위치도 달라집니다. 이미 라우팅된 세션은 선택한 티어를 유지하므로 변경된 분류 동작은 새 세션에서 확인하세요.

푸터에는 `laya starting`, `laya on`, `laya idle`, `laya unavailable`, `laya off` 상태가 표시됩니다. `/laya off`는 해당 로컬 포트에서 실행 중인 다른 pi 또는 수동 실행의 `laya-serve`도 종료할 수 있습니다.

## 데이터셋 로그

새로 라우팅된 세션마다 `~/.pi/agent/laya-dataset.jsonl`에 JSON 한 줄이 추가됩니다(`PI_CODING_AGENT_DIR`을 따름). Laya가 본 프롬프트(최대 16,000자), 티어별 확률, 난이도 원점수, 실제 사용한 티어·모델·thinking 레벨이 기록됩니다. Laya가 꺼진 상태로 라우팅된 세션은 답 없이 기록됩니다. `session`은 pi 세션 파일과 같은 값이며, 그 파일의 `thinking_level_change`, `model_change` 항목으로 사용자가 라우팅을 바꾼 지점을 알 수 있습니다. 프롬프트 원문이 담기므로 세션 파일처럼 다루세요.
