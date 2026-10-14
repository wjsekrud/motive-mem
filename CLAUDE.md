# CLAUDE.md

Motive-mem — Claude Code 모드 하나(`motive-mem`)와 그 스킬 하나(`principles`). 소개는 `README.md`. 문서·주석·문구는 한국어.

## 구성

| 경로 | 무엇 |
| --- | --- |
| `.claude-plugin/plugin.json` | 매니페스트 · `userConfig`(model · effort · maxDiffChars · openOnIssue) |
| `.claude-plugin/marketplace.json` | 이 폴더를 마켓플레이스로 — 설치본이 이 폴더 자체다 |
| `hooks/core.ts` | 순수 함수: 원칙 읽기 · glob · diff 나누기 · 리뷰 요청 만들기 · 답 읽기 · 패널 글. 리뷰어 시스템 프롬프트 `SYSTEM` 도 여기 |
| `hooks/register.tsx` | 엔진에 붙는 쪽: 턴 시작·끝 스냅숏 · 백그라운드 리뷰 · 명령 · 패널 |
| `hooks/core.test.ts` | `claude plugin test .` 로 돈다 |
| `types/index.d.ts` | 리뷰 자료형과 `PluginState['motive-mem']` |
| `skills/principles/` | 원칙 파일을 캐내는 스킬 |

`.claude-plugin/types/` 는 엔진이 써 주는 타입이다(gitignore). 없으면 이 폴더에서 plugin-authoring 스킬을 불러 다시 받는다.

## 검사

```sh
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p tsconfig.json --noEmit
```

- `$` 는 모듈 맨 윗단 함수에만 넘긴다(검사기가 막는다) — 그래서 `register.tsx` 의 도우미는 전부 맨 윗단에 있다.
- 판단이 들어가는 것은 `core.ts` 에 두고 테스트를 붙인다. `register.tsx` 는 엔진과 git 을 부르는 일만.
- 상태 키 · 명령 이름 · 패널 id · 기록 폴더(`.git/motive-mem/`)는 모두 플러그인 이름과 같다. 이름을 바꾸면 함께 바꾼다.

## 리뷰어 프롬프트나 스킬을 고칠 때

`SYSTEM`(core.ts)이나 원칙 형식을 바꾸면 리뷰어 판단 시험을 다시 돌린다 — 정상 변경에 지적이 없어야 한다(사소한
지적은 패널을 괜히 연다).

스킬(`principles`)을 고치면 새 에이전트에게 스킬만 주고 원칙 파일을 처음부터 만들게 해서, 모호했던 곳을 묻는다.
원칙을 더 세게 · 더 많이 만들게 하는 쪽으로 고치지 않는다 — 원칙 파일이 불어나는 것이 이 모드가 막으려는 드리프트다.
