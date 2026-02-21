# Dalil (MVP v0.1)

Dalil은 채용 지원서 페이지의 `input`/`textarea` 작성을 돕는 local-first CLI + Runner입니다.

## Scope

- Draft + insert text only
- No navigation
- No submit actions
- Local-only persistence under a user-selected data directory

## Quick Start

### 1) 설치 및 기본 체크

```bash
cd /Users/zakklee/dev/dalil
npm ci
npm run check
```

`npm run check`는 아키텍처 import 규칙 검사(`arch:check`)와 타입 빌드(`build`)를 함께 수행합니다.

### 2) 데이터 디렉토리 초기화

```bash
node dist/main.js init --data-dir /absolute/path/to/dalil-data
```

이 경로가 Dalil Data Directory가 되며, vault/history/secrets/runtime 파일이 로컬에 생성됩니다.

### 3) OpenAI API 키 설정

```bash
node dist/main.js config set openai.key
```

프롬프트에 API 키를 입력하면 로컬 데이터 디렉토리에 저장됩니다.

### 4) 커리어 자료 import

```bash
node dist/main.js vault import /path/resume.pdf /path/portfolio.docx --type resume
node dist/main.js vault status
```

### 5) Runner 실행

```bash
node dist/main.js run --mode managed
```

`run`은 Runner를 시작하고 TUI를 엽니다. Runner만 백그라운드처럼 유지하려면 `--daemon`을 사용합니다.

### 6) 다른 터미널에서 필드 작성

```bash
node dist/main.js fields list
node dist/main.js suggest <fieldId> --variant standard --lang ko
node dist/main.js apply <fieldId> --suggestion <suggestionId>
```

## 명령어 설명

아래 표기는 `dalil` 기준입니다. 로컬 실행 시에는 `node dist/main.js`로 치환해서 실행하면 됩니다.

| 그룹 | 명령어 | 설명 |
|---|---|---|
| Setup | `dalil init --data-dir <path>` | 데이터 디렉토리 초기화 및 전역 config 등록 |
| Setup | `dalil config set openai.key` | OpenAI API 키 저장(입력 프롬프트) |
| Setup | `dalil doctor` | 환경 점검(경로 권한, 키 설정, Playwright, 편집기 등) |
| Runner | `dalil run [--mode managed/attach] [--cdp <url>] [--port <n>] [--daemon]` | Runner 시작 및 TUI 진입 |
| Vault | `dalil vault import <file...> [--type resume/portfolio/notes]` | 이력서/포트폴리오/노트 import 및 프로필 갱신 |
| Vault | `dalil vault status` | vault 요약 정보 확인 |
| Fields | `dalil fields list [--format table/json]` | 현재 페이지 입력 필드 스캔 결과 조회 |
| Fields | `dalil fields show <fieldId>` | 필드 상세 메타데이터 확인 |
| Fields | `dalil fields highlight <fieldId>` | 브라우저에서 필드 하이라이트 |
| Suggest | `dalil suggest <fieldId> [--variant concise/standard/impact] [--lang ko/en]` | 단일 필드 답변 초안 생성 |
| Suggest | `dalil suggest --all [--variant ...] [--lang ...]` | 페이지 전체 필드 초안 생성 |
| Suggest | `dalil suggest show <suggestionId> [--with-citations]` | 저장된 suggestion 조회 |
| Apply | `dalil apply <fieldId> --suggestion <suggestionId>` | 저장된 suggestion을 필드에 반영 |
| Apply | `dalil apply <fieldId> --text @-` | stdin 텍스트를 필드에 반영 |
| Revert | `dalil revert <fieldId>` | 마지막 반영 내용 롤백 |
| History | `dalil history list [--site <etld+1>] [--limit N]` | 반영 기록 목록 조회 |
| History | `dalil history show <historyId> [--format text/json]` | 단일 기록 상세 조회 |
| History | `dalil history search <query>` | 라벨/사이트/본문 기준 기록 검색 |
| Export | `dalil export resume --lang ko/en --template <id> --out <path.md>` | 이력서 Markdown export |
| Export | `dalil export portfolio --lang ko/en --template <id> --out <path.md>` | 포트폴리오 Markdown export |

## 자주 쓰는 옵션

- `--data-dir <path>`: 전역 설정 대신 특정 데이터 디렉토리를 강제로 사용
- `--format json`: list/show 계열 명령을 JSON으로 출력
- `--json`: 일부 명령에서 `--format json`의 축약 옵션

## Notes

- `run` 명령은 Playwright가 필요합니다: `npm i playwright`
- Import는 PDF/DOCX/text를 지원합니다.
- Export는 Markdown(`.md`)만 지원합니다.
- 아키텍처 문서: `/Users/zakklee/dev/dalil/docs/architecture.md`
