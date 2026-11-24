# 샌드박스

[English](sandbox.md) | **한국어**

bash는 [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) 안에서 실행됩니다(macOS는 sandbox-exec, Linux는 bubblewrap). pi 프로세스 안에서 도는 파일 도구(`read`, `grep`, `find`, `ls`, `write`, `edit`, `handoff`의 계획 파일 읽기)는 실행 전에 같은 경로 규칙으로 검사합니다.

- **쓰기**는 프로젝트, 임시 디렉터리, `/tmp`에만 됩니다. 프로젝트는 pi가 실행되는 디렉터리입니다. 런타임이 항상 보호하는 이름(`.bashrc`, `.zshrc`, `.gitconfig`, `.git/hooks`, `.git/config`, `.vscode`, `.claude/commands` 등)을 그 디렉터리와 그 아래에서만 보호하기 때문입니다. 이 패키지는 git이 다른 곳의 설정을 읽게 만들 수 있는 프로젝트의 `.git/commondir`, `.git/config.worktree`, `.git/modules/`, `.git/worktrees/`도 막습니다. 그래서 bash에서 서브모듈이나 worktree를 추가하려면 위험도 판정을 거쳐야 합니다. Linux에서는 런타임이 없는 경로 자리에 빈 파일을 끼워 git이 깨지므로, pi가 먼저 `.`(저장소 자신의 디렉터리)을 담은 `commondir`을 만들고 그 파일을 읽기 전용으로 막습니다. `.git`, `.claude`, `.vscode`, `.idea` 안에서 시작한 pi에는 프로젝트가 없습니다. 서브에이전트처럼 UI가 없는 pi는 자신의 `cwd`가 자신을 띄운 pi의 프로젝트 안에 있을 때만 그 `cwd`를 프로젝트로 받으므로, `cwd` 인자로 쓰기 범위를 좁힐 수는 있어도 넓힐 수는 없습니다. pi의 에이전트 디렉터리(`~/.pi/agent`)는 언제나 쓸 수 없습니다. 임시 디렉터리에서는 bash에 이 보호가 걸리지 않아, `/tmp` 아래 저장소의 hooks는 bash가 바꿀 수 있습니다. pi의 파일 도구는 보호되는 이름을 어디서든 거부합니다.
- **막힌 쓰기, localhost, TLS 확인**: 이 밖에 쓰거나, localhost에 바인딩하거나, (macOS) TLS 인증서를 확인하다가 명령이 실패하고 pi에 UI가 있고 `PI_SANDBOX_ESCALATE=off`가 아니면, 그 접근을 실행 한 번에 대화 상자 하나로 제안합니다. `… | head`가 실패를 가려 명령이 0으로 끝나도 마찬가지입니다.
  - 제안: 그 경로를 덮는 디렉터리. localhost(`network.allowLocalBinding`. localhost만이 아니라 모든 인터페이스와 포트에서 바인딩하고 연결을 받을 수 있고, 호스트 허용 목록을 우회할 수 있는 프록시나 포워더를 포함해 모든 localhost 서비스에 접속할 수 있음. macOS 전용. Linux 샌드박스는 자체 루프백이 있고 런타임이 이 설정을 쓰지 않음). trustd(최상위 `enableWeakerNetworkIsolation`, macOS. Dart와 Flutter가 TLS 인증서를 확인하는 데 필요하며, 런타임은 데이터 유출 경로가 될 수 있다고 경고함).
  - Flutter/Dart 계기(그 디렉터리 안의 경로, Dart의 `Failed to create server socket`, 또는 그 인증서 실패)는 아직 닫힌 부분을 모두 한 번에 제안합니다: Flutter/Dart 디렉터리 전부(`~/fvm`, `~/.pub-cache`, `~/.dart-tool`, `~/.dartServer`, `~/.flutter`, `~/.flutter-devtools`, `~/.config/flutter`, `~/Library/Caches/flutter_engine`, 안전하지 않거나 심볼릭 링크인 것은 뺌), localhost, trustd. 다른 계기는 자기 부분만 제안합니다: 도구 디렉터리 하나(예: `~/.gradle`, `~/Library/Caches/<이름>`, `~/Library/Application Support/<이름>`), 또는 localhost, 또는 trustd. No는 세션 동안 유지되고, 대화 상자를 닫은 것은 그렇지 않습니다.
  - 제안하지 않음: 홈 자체, `~/.config`, `~/.local`, `~/.claude`, `~/.pi`, `~/.ssh`, `~/.git`, 다른 `~/Library` 디렉터리, 디렉터리인 척하는 파일, 자격 증명 경로와 겹치는 디렉터리, 홈 밖.
  - 이번 세션만 또는 항상(`sandbox.json`에 덧붙임) 허용하면 명령을 샌드박스 안에서 다시 실행합니다. Linux에서는 런타임이 있는 디렉터리만 마운트하므로 없는 디렉터리를 먼저 만듭니다. 0으로 끝난 명령은 다시 실행하지 않습니다(로그를 `cat`한 것처럼 차단 문구를 출력만 했을 수 있음). 그 접근이 필요하면 다시 실행하세요. No면 에스컬레이션으로 넘어가고, 이번 세션에서는 같은 부분을 다시 묻지 않습니다(대화 상자를 닫기만 하면 다음에 다시 묻습니다).
  - UI가 없으면 high로 평가된 명령의 메시지에 붙여 넣을 `sandbox.json`이 담깁니다. 0으로 끝난 명령도 분류기 없이 같은 내용을 받고, UI가 있는 pi(부모 세션)가 같은 명령을 실행하면 대화 상자가 뜬다고 알립니다.
- **읽기**는 `~/.ssh`(그 안의 `config`와 `known_hosts`는 읽을 수 있음), `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.config/gh`, `~/.pi/agent/auth.json`을 빼고 열려 있습니다. 이 중 하나를 품은 디렉터리를 `grep`하는 것도 막습니다. 다른 곳에 있거나 환경 변수에 든 자격 증명은 보호하지 않습니다.
- **네트워크**는 `github.com`, `*.github.com`, `*.githubusercontent.com`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`에 접속합니다. 다른 호스트는 `openai/gpt-6.1-terra`가 세션마다 한 번 평가합니다. low(패키지 레지스트리, 툴체인 다운로드, 작업에 필요한 문서)면 경고와 함께 세션 동안 허용하고, high이거나 분류기가 실패하면 사용자에게 묻고, UI가 없는 pi(서브에이전트, 리뷰 게이트, `pi -p`)는 세션 동안 거부합니다. 허용된 호스트는 이후 명령이 읽을 수 있는 모든 것을, 프로젝트 파일까지 받을 수 있습니다. `PI_SANDBOX_ESCALATE=off`면 다른 호스트는 모두 사용자에게 묻고, UI가 없으면 거부합니다. macOS에서는 `SSH_AUTH_SOCK`에 접근할 수 있지만, 그것만으로 ssh를 통한 git이 동작하지는 않습니다.
- **확인**: `sudo`, `git … push`, 재귀 `rm`이 든 bash와, 이름이 `.env`로 시작하는 파일의 `write`/`edit`는 샌드박스를 꺼도 먼저 묻고, UI가 없으면 막습니다. 명령 텍스트로 판단하므로 경계가 아니라 과속 방지턱입니다.
- **에스컬레이션**: 샌드박스 안의 bash 명령이 실패하고 샌드박스 차단 흔적(`Operation not permitted`, `EPERM`, 읽기 전용 파일 시스템, 막힌 호스트, macOS 인증서 확인 `CERTIFICATE_VERIFY_FAILED … application verification failure`)이 보이면, `openai/gpt-6.1-terra`가 그 명령을 샌드박스 없이 실행할 때의 위험을 평가합니다. low면 같은 명령을 샌드박스 밖에서 다시 실행하고, 출력에 표시 줄을 남기고 경고를 띄웁니다. high면 사용자에게 묻고, UI가 없으면(서브에이전트, 리뷰 게이트, `pi -p`) 거부하며 모델에게 사용자에게 물어보라고 알립니다. `sudo`, `git push`, `rm -r`은 항상 사용자에게 가고, 실행 중에 호스트가 거부된(사용자가 거절했거나, UI 없이 high로 평가된) 명령(다시 실행하기 직전에 한 번 더 확인)은 다시 실행하지 않습니다. 명령, 작업 디렉터리, 프로젝트 루트 경로, 차단 줄, 사용자의 마지막 메시지가 OpenAI로 전송됩니다. 알 수 없는 호스트는 호스트, 포트, 실행 중인 명령 최대 5개(각 2000자, 런타임이 어느 명령의 요청인지 알려주지 않음), 사용자의 마지막 메시지가 전송됩니다. OpenAI 인증이 없거나, 분류기 오류나 불완전한 응답은 모두 high로 칩니다. 다시 실행할 때는 샌드박스가 전혀 없고(쓰기 제한, 호스트 허용 목록, 자격 증명 읽기 차단 모두 없음), 분류기는 경계가 아니라 과속 방지턱입니다. 명령이나 출력 속 프롬프트 인젝션, 또는 가짜 차단 문구를 출력하는 명령으로 샌드박스 없이 실행될 수 있습니다. 차단되기 전에 일부 실행된 명령은 한 번 더 실행됩니다. 감지는 최선 노력일 뿐이라, OS 메시지를 감추는 Java나 Gradle 오류는 감지하지 못하고 그냥 실패로 남습니다. `PI_SANDBOX_ESCALATE=off`로 에스컬레이션, 호스트 평가, 접근 허용 제안을 끕니다.
- **powershell**: pi의 `powershell` 도구는 OS 샌드박스 밖에서 실행되므로, 샌드박스가 켜져 있으면 막습니다. bash를 쓰세요.

기본값은 `~/.pi/agent/sandbox.json`으로 넓힙니다. 목록은 기본값 뒤에 덧붙고, 단일 값은 기본값을 바꿉니다. 파일 시스템 항목은 경로입니다(`~`와 프로젝트 기준 상대 경로는 되고, glob은 거부). `filesystem`과 `network` 밖의 최상위 키는 `enableWeakerNetworkIsolation`(true 또는 false, 위의 trustd) 하나뿐입니다. 형식이 잘못된 파일이면 샌드박스가 시작하지 않습니다.

```json
{"filesystem": {"allowWrite": ["~/.npm"]}, "network": {"allowedDomains": ["example.com"]}}
```

쓰기 가능한 디렉터리를 하나 더할 때마다 bash가 거기에 코드를 심어 나중에 샌드박스 밖에서 실행되게 할 수 있습니다(대화 상자도 이를 알립니다. `~/.npm`, `~/.cache` 같은 도구 캐시에는 코드가 들어 있습니다). 그래서 기본값에는 하나도 없습니다.

실패하면 닫힙니다. 샌드박스가 뜨기 전이나 뜨지 못할 때(로컬 체크아웃에서 `npm ci`를 하지 않아 sandbox-runtime이 없거나, ripgrep이 없거나, Linux에 bubblewrap이나 socat이 없을 때) bash와 검사 대상 도구는 이유와 해결 방법을 담아 막히고, bash가 샌드박스 없이 실행되는 일은 없습니다. `PI_SANDBOX=off pi`는 확인 질문은 남기고 두 층을 모두 끄고, 시작할 때 경고를 띄웁니다. 실행 중인 pi에서 `/sandbox`는 상태를 보여 주고, `/sandbox off`는(UI가 있을 때 확인을 거쳐) 그 pi와 이후에 시작하는 서브에이전트와 리뷰 게이트([읽기 전용 서브에이전트](#읽기-전용-서브에이전트)는 제외)의 두 층을 끄며(확인 질문은 남김), `/sandbox on`은 다시 켜고 샌드박스가 뜬 적이 없으면 시작합니다. 사용자만 풀 수 있게 막힌 bash 명령은 모델에게 사용자에게 `sandbox.json`에서 허용하거나 `/sandbox off`를 실행해 달라고 요청하라고 알립니다.

프로젝트가 이 패키지의 체크아웃 자체라면 `node_modules/`, `package.json`, `package-lock.json`, `.npmrc`만 보호합니다. 의존성은 직접 연 터미널에서 바꾸세요. 소스는 계속 수정할 수 있고, 그 수정은 `/reload`, 재시작, 또는 다음 서브에이전트 시작 때 샌드박스 밖에서 실행됩니다. 프로젝트가 로드된 패키지를 품고 있으면 pi가 시작할 때 경고합니다. bash가 패키지 코드를 바꿀 수 없게 하려면 git으로 설치하고 별도 체크아웃에서 작업하거나, 체크아웃을 `filesystem.denyWrite`에 추가하세요.

다루지 않는 것: `!`나 `!!`로 직접 입력한 명령, Claude CLI 자체의 WebSearch와 WebFetch, pi 프로세스 자체와 pi가 신뢰하는 확장(신뢰한 프로젝트의 `.pi` 확장 포함), `read`가 실행하는 poppler·pandoc·LibreOffice 변환기, 도구의 검사와 실제 사용 사이에 파일이 바뀌는 경우. `extensions/sandbox/index.ts` 자체가 로드되지 않으면 pi는 그것을 건너뛰고, 아무것도 샌드박스되지 않습니다. 샌드박스 테스트(`extensions/sandbox/*.test.ts`)는 신뢰할 수 있는 터미널이나 CI에서 실행하세요. 실제 샌드박스는 다른 샌드박스 안에서 시작하지 못합니다.

## 읽기 전용 서브에이전트

프론트매터에 `sandbox: read-only`가 있는 에이전트(이 값만 인식하며, 이 패키지에서는 `reviewer`에만 있습니다)는 `PI_SANDBOX_READONLY=1`로 시작하고, 그 샌드박스는 다음과 같습니다.
- bash와 `write`/`edit`는 임시 디렉터리와 `/tmp`에만 쓸 수 있습니다. 작업 디렉터리, 프로젝트, `sandbox.json`의 `filesystem.allowWrite`에는 쓸 수 없고, `denyRead`, `allowRead`, `network`는 그대로 적용됩니다. 형식이 잘못된 설정은 여전히 시작을 막습니다.
- 에스컬레이션도 접근 허용 제안도 없습니다. 막힌 명령은 평가하거나 다시 실행하지 않고, 실패한 명령의 출력 끝에 읽기 전용이라는 안내를 붙입니다. 모르는 호스트는 평가 없이 거부합니다.
- `PI_SANDBOX=off`를 무시합니다. `/sandbox off`를 실행했거나 `PI_SANDBOX=off`로 시작한 pi에서도 이후에 시작하는 리뷰어는 자기 읽기 전용 샌드박스를 띄우고, 리뷰 도중의 `/sandbox off`는 이미 실행 중인 리뷰어에 닿지 않습니다(환경 변수는 시작할 때 복사됩니다). 리뷰어에게는 UI가 없어 `/sandbox off`를 실행할 수 없고, bash에서 바꾼 환경 변수는 그 명령의 자식 프로세스에만 영향을 주며, 자식도 `PI_SANDBOX_READONLY`를 물려받습니다.
- 다른 pi처럼 실패하면 닫힙니다. 시작하지 못했거나 시작되지 않은 상태이면 bash와 검사 대상 도구가 막힙니다.

`git status`, `diff`, `log`, `show`, `node --test`, `node -e`는 동작합니다. 임시 디렉터리 아래의 프로젝트(`/tmp`, `$TMPDIR`. 게이트 평가의 픽스처 등)는 임시 디렉터리가 쓰기 가능하므로 계속 쓸 수 있습니다. `~/.pi/agent/agents/`에 같은 이름의 에이전트 파일이 있으면 프론트매터까지 통째로 대체되므로, 그 파일에도 `sandbox: read-only`를 넣으세요. 프로젝트 `.pi/agents/`의 파일은 `agentScope`가 `"both"`나 `"project"`인 `subagent` 도구에서만 대체하고, 리뷰 게이트는 사용자 에이전트만 불러옵니다.

복사본 대체: 리뷰어의 도구 결과가 `sandbox: could not start` 또는 `sandbox: not started`를 알리면 리뷰 게이트는 그 시도를 버리고, 작업 트리 전체(`.git`과 무시된 파일 포함)를 권한 0700의 전용 임시 디렉터리 안에 copy-on-write로 복제해(macOS는 `cp -cR`, Linux는 `cp -a --reflink=auto`, 복제를 지원하지 않는 볼륨에서는 일반 복사) `PI_SANDBOX=off`로 리뷰하며, pi를 다시 시작할 때까지 이후 리뷰도 모두 그렇게 합니다. 복사본은 리뷰가 끝나면, Esc나 시간 초과로 끝나도 지웁니다. 대체 리뷰를 시작하기 전에 작업 디렉터리와 Git 작업 트리 루트, Git 디렉터리, 공통 Git 디렉터리가 모두 복사본 안으로 해석되는지 검사하고, 물려받은 Git 환경 변수 재정의를 제거합니다. 복사에 실패하거나, 연결된 worktree나 서브모듈이거나, Git 경로가 밖을 가리키면 경고와 함께 변경은 리뷰되지 않습니다.

이 대체는 보안 경계가 아닙니다. 독립적으로 복사된 파일에 쓴 내용은 원본을 바꾸지 않지만, 샌드박스 없는 리뷰어는 절대 경로나 바깥을 가리키는 심볼릭 링크로 원래 저장소에 접근할 수 있고, 홈 디렉터리·자격 증명·네트워크에도 닿을 수 있습니다. 이를 금지하는 것은 프롬프트뿐입니다. 게이트는 원래 저장소를 작업 디렉터리로 삼아 대체 리뷰를 시작하지 않지만, 샌드박스 없이 리뷰어의 명시적인 원본 접근까지 막을 수는 없습니다. 이 대체는 리뷰 게이트에만 있고, `subagent` 도구와 `/implement-and-review`의 리뷰어는 막힌 채로 남습니다.
