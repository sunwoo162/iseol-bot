# 이설 · Iseol

Discord 안에서 프로젝트 생성부터 작업, Scrum, GitHub, Calendar, 코드리뷰까지 이어주는 프로젝트 자동화 봇입니다.

프로젝트를 만들고 나면 팀원은 대부분 Slash Command 대신 `📌・프로젝트` 허브의 버튼만 사용하면 됩니다.

```text
📌 프로젝트 허브
├─ ➕ 작업 만들기
├─ 📋 내 작업
├─ 📋 스크럼
├─ 🐙 GitHub
└─ ⋯ 더보기
   ├─ 📅 일정 관리
   ├─ 🔍 리뷰 상태
   ├─ 🔄 새로고침
   └─ ⚙️ 관리
```

## 주요 기능

- 프로젝트 생성 시 Discord 카테고리/채널 자동 구성
- Frontend/Backend GitHub 저장소 연결 및 로그 채널 자동화
- 작업 생성 → GitHub Issue + Discord 작업 카드 + Google Calendar 일정 연결
- 작업 완료/수정 시 GitHub Issue와 Calendar 상태 동기화
- 버튼 기반 Daily Scrum 작성/수정/전날 TODO carry
- Discord 사용자 ↔ GitHub 사용자명 1회 연결 후 재사용
- Google Calendar 원클릭 OAuth 연결
- GitHub Actions 기반 무료 정적분석 Code Review
- 프로젝트 상태 진단/자동 복구/빠른 연동 도우미
- Docker Compose 배포 및 `npm run doctor` 설치 진단

---

## 5분 빠른 시작

가장 간단한 방법은 Docker Compose입니다. 호스트에 Node.js를 별도로 설치하지 않아도 됩니다.

### 1. 저장소 준비

```bash
git clone https://github.com/sunwoo162/iseol-bot.git
cd iseol-bot
cp .env.example .env
```

Windows PowerShell에서는 다음처럼 복사할 수 있습니다.

```powershell
Copy-Item .env.example .env
```

### 2. `.env`의 Core 값 입력

최소한 아래 5개가 필요합니다.

```env
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
GITHUB_TOKEN=...
FIGMA_TOKEN=...
NOTION_TOKEN=...
```

Google Calendar는 나중에 연결해도 됩니다.

### 3. 이미지 빌드 + 설정 진단

```bash
docker compose build
docker compose run --rm iseol npm run doctor:prod
```

`doctor`는 secret 값을 출력하지 않고 다음만 알려줍니다.

- Core 설정 준비 여부
- Google OAuth 준비 여부
- Google 계정 1회 연결 필요 여부
- GitHub Code Review 권한 확인 항목

Core 항목이 빠져 있으면 종료 코드 `1`, 선택 연동만 빠져 있으면 `0`입니다.

### 4. Slash Command 등록

```bash
docker compose run --rm iseol npm run register:prod
```

### 5. 실행

```bash
docker compose up -d
```

로그 확인:

```bash
docker compose logs -f iseol
```

종료:

```bash
docker compose down
```

`data/` 런타임 상태는 Docker named volume `iseol-data`에 영속 저장됩니다.

---

## Discord Bot 준비

Discord Developer Portal에서 Application과 Bot을 생성합니다.

권장 Bot 권한:

- View Channels
- Send Messages
- Embed Links
- Attach Files
- Manage Channels
- Manage Webhooks
- Manage Messages
- Connect
- Speak
- Mention Everyone

OAuth2 URL Generator에서는 다음 scope를 사용합니다.

- `bot`
- `applications.commands`

`DISCORD_CLIENT_ID`에는 Discord Application ID를 넣습니다.

Slash Command는 글로벌 명령으로 등록됩니다. `DISCORD_GUILD_ID`는 예전 Guild Command를 정리할 때만 선택적으로 사용합니다.

---

## GitHub Token 준비

Fine-grained Personal Access Token을 만들고 이설이 관리할 저장소에 접근 권한을 부여합니다.

권장 Repository Permission:

- Metadata: Read
- Contents: Read and write
- Workflows: Read and write
- Actions: Read
- Pull requests: Read and write
- Issues: Read and write
- Webhooks: Read and write

Organization 초대 기능까지 사용할 경우 Organization Members 쓰기 권한도 필요합니다.

이설은 Discord에 PAT 입력창을 만들지 않습니다. `GITHUB_TOKEN`은 서버의 `.env`에만 두고, Discord에서는 `🔐 GitHub 권한 안내`를 통해 필요한 권한만 확인합니다.

---

## 첫 프로젝트 만들기

Discord에서 다음 명령을 실행합니다.

```text
/project create
```

기본 입력:

- 프로젝트 이름
- Frontend GitHub 저장소
- Backend GitHub 저장소
- Notion URL · 선택
- Figma URL · 선택

Frontend/Backend 저장소는 같은 GitHub Organization 아래에 있어야 합니다.

생성되는 기본 구조:

```text
📁 프로젝트명
├─ 📢・공지
├─ 📌・프로젝트
├─ 📄・기능명세서
├─ 🎨・figma
├─ 💬・토론
├─ 🗓・데일리스크럼
├─ 💻・frontend-log
├─ 🛠・backend-log
└─ 📅・일정
```

고정 메시지는 안내/이동용이고 실제 버튼 조작은 `📌・프로젝트`의 live hub에서 합니다.

---

## 일반 팀원 사용 흐름

### 작업 만들기

`➕ 작업 만들기` 버튼에서 다음만 입력합니다.

- 작업 제목
- 마감 시간
- 설명 · 선택

예시 시간:

```text
내일 18:00
9/3 14:30
2026-09-03 14:30
```

이설은 가능한 경우 자동으로 다음을 연결합니다.

```text
작업 입력
  ↓
GitHub Issue 생성
  ↓
Google Calendar 일정 생성
  ↓
Discord 작업 카드 생성
  ↓
[완료] [수정] [더보기]
```

작업 완료/수정은 작성자 또는 프로젝트 관리자만 할 수 있습니다.

### Daily Scrum

프로젝트 허브의 `📋 스크럼`에서 다음 기능을 사용합니다.

- 오늘 TODO/DID 작성 또는 수정
- 전날 TODO를 오늘 DID로 가져오기
- 내 최근 기록 확인

매일 오전 8시(Asia/Seoul)에 프로젝트 Scrum 채널로 작성 알림을 보냅니다.

기존 Slash Command도 호환됩니다.

```text
/scrum write todo:<오늘 할 일> did:<완료한 일>
```

### GitHub 계정 연결

프로젝트 허브의 `🐙 GitHub`에서 GitHub 사용자명을 한 번 연결하면 같은 Discord 서버에서 재사용합니다.

연결 후에는:

- 프로필 확인
- Organization 참여
- 프로젝트 작업의 GitHub identity 재사용
- 연결 해제

이 가능합니다.

기존 `/github connect`, `/github profile`, `/github disconnect`도 유지됩니다.

---

## Google Calendar 연결

사용자가 refresh token을 직접 복사할 필요가 없습니다.

### 서버 관리자 1회 설정

`.env`에 다음을 설정합니다.

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
PUBLIC_BASE_URL=https://iseol.example.com
```

Google Cloud Console에서 Calendar API를 활성화하고 OAuth 2.0 Client의 Authorized redirect URI에 다음 주소를 등록합니다.

```text
https://iseol.example.com/google/oauth/callback
```

`PUBLIC_BASE_URL` 뒤의 `/google/oauth/callback`이 기본 callback입니다. 특별한 경우에만 `GOOGLE_REDIRECT_URI`로 직접 지정합니다.

설정을 바꿨다면 컨테이너를 재시작합니다.

```bash
docker compose up -d --build
```

### Discord에서 사용자 1회 연결

```text
📌 프로젝트 허브
→ ⚡ 연동 도우미
→ 📅 Calendar 만들기
→ Google Calendar 연결
→ Google 로그인/권한 승인
```

승인이 끝나면 이설이 자동으로:

1. refresh token을 `data/google-oauth.json`에 저장
2. 프로젝트 Calendar 생성
3. 프로젝트에 Calendar ID/URL 저장
4. Discord 허브 상태 갱신

을 수행합니다.

`GOOGLE_REFRESH_TOKEN`은 기존 설치 호환 또는 강제 override 용도로만 남아 있으며 일반 설치에서는 비워둡니다.

---

## 빠른 연동 도우미

프로젝트에 빠진 연결이 있으면 허브에 `⚡ 연동 도우미`가 표시됩니다.

```text
[🚀 가능한 항목 자동 연결]
[🐙 GitHub 복구]
[📅 Calendar 만들기]
[🔐 GitHub 권한 안내]
[📄 Notion 설정]
[🎨 Figma 설정]
```

자동 연결은 기존 리소스를 가능한 한 재사용하며 같은 webhook/channel/workflow를 중복 생성하지 않도록 동작합니다.

외부 API 오류 원문이나 token 값은 일반 사용자 메시지에 노출하지 않습니다.

---

## 무료 PR Code Review

기본 리뷰는 Gemini/OpenAI 등 유료 LLM API를 호출하지 않습니다.

```text
PR opened / reopened / synchronize
  ↓
Iseol Code Review GitHub Actions
  ↓
ESLint / TypeScript / npm audit / Knip / dependency-cruiser
  ↓
선택: Semgrep / Gitleaks / Trivy / OSV / actionlint
  ↓
정규화된 review artifact
  ↓
이설 outbound polling
  ↓
변경된 RIGHT-side line 필터링
  ↓
PR summary + inline review comments
```

정책:

- 같은 `repository + PR + HEAD SHA`는 한 번만 리뷰
- 변경된 line 위주로 comment
- 스타일/quote/semicolon 같은 낮은 가치의 잡음 제거
- 중복 finding 병합
- 일반 inline comment 최대 5개
- 중요한 security finding은 별도 유지 가능
- 자동 merge/merge 차단은 하지 않음
- fork PR은 신뢰된 self-hosted runner에서 실행하지 않음

Public 저장소는 GitHub-hosted runner를 사용합니다.

Private 저장소는 격리된 `iseol-review` self-hosted runner가 필요합니다. 운영 방법은 `docs/operations/iseol-review-runner.md`를 참고하세요.

기존 프로젝트에 workflow를 수동으로 한 번 설치하려면:

```bash
npm run review:install-workflows
```

GitHub API가 `403` 또는 workflow 권한 오류를 반환하면 Discord의 `🔐 GitHub 권한 안내`에서 필요한 PAT 권한을 확인한 뒤 `🚀 가능한 항목 자동 연결`을 다시 실행하면 됩니다.

---

## Notion / Figma

서버 API token은 Core 환경변수로 설정합니다.

```env
FIGMA_TOKEN=...
NOTION_TOKEN=...
```

각 프로젝트의 Notion/Figma URL은 프로젝트 생성 시 생략해도 되고, 나중에 `⚡ 연동 도우미`에서 링크만 추가할 수 있습니다.

허용 URL 예:

- Notion: `https://www.notion.so/...`, `https://*.notion.site/...`
- Figma: `/design/...`, `/file/...`, `/board/...`, `/proto/...`

---

## Docker 운영

기본 Compose 구성:

- Node.js 22
- TypeScript multi-stage build
- production dependency만 runtime image에 설치
- ffmpeg 포함
- non-root `node` 사용자 실행
- Integration HTTP port `8787`
- named volume `iseol-data:/app/data`
- `.env`, `data/`, `.git`은 Docker build context에서 제외

외부 포트를 바꾸고 싶다면:

```env
ISEOL_PORT=18787
```

컨테이너 내부 integration port는 항상 `8787`로 유지됩니다.

데이터까지 제거하고 완전히 초기화할 때만 다음을 사용하세요.

```bash
docker compose down -v
```

`-v`는 저장된 프로젝트/OAuth/runtime 상태를 삭제하므로 일반 업데이트에서는 사용하지 마세요.

업데이트:

```bash
git pull
docker compose up -d --build
```

---

## Docker 없이 실행

Node.js 22 기준입니다.

```bash
npm ci
cp .env.example .env
npm run doctor
npm run register
npm run build
npm start
```

개발 모드:

```bash
npm run dev
```

---

## 환경변수 요약

### Core

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
GITHUB_TOKEN=
FIGMA_TOKEN=
NOTION_TOKEN=
```

### Google Calendar · 선택

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
PUBLIC_BASE_URL=
GOOGLE_REFRESH_TOKEN=
GOOGLE_REDIRECT_URI=
```

### 기타 선택 기능

```env
DISCORD_GUILD_ID=
ISEOL_REVIEW_COLLECTOR_REF=
GEMINI_API_KEY=
GITHUB_WEBHOOK_SECRET=
WEBHOOK_PORT=
ISEOL_PORT=8787
```

`GEMINI_API_KEY`와 `GITHUB_WEBHOOK_SECRET`은 기존 signed-webhook AI fallback을 사용할 때만 필요합니다.

---

## 데이터와 보안

- `.env`는 Git에 커밋하지 않습니다.
- `data/` 전체가 Git ignore 대상입니다.
- Google OAuth refresh token은 runtime `data/google-oauth.json`에만 저장합니다.
- Docker build context에도 `.env`와 `data/`가 들어가지 않습니다.
- Discord UI에서 PAT/OAuth Client Secret을 입력받지 않습니다.
- 자동 복구는 사용자 채널/메시지를 임의 삭제하지 않습니다.
- 프로젝트별 데이터는 Discord `guildId`를 기준으로 분리합니다.

---

## 문제 해결

### 무엇이 빠졌는지 모르겠음

```bash
npm run doctor
```

Docker:

```bash
docker compose run --rm iseol npm run doctor:prod
```

### Google 로그인 후 callback이 안 됨

확인할 항목:

- `PUBLIC_BASE_URL`이 외부에서 접근 가능한 HTTPS 주소인지
- Google Cloud Authorized redirect URI가 정확한지
- reverse proxy가 `/google/oauth/callback`을 컨테이너 `8787`로 전달하는지
- `docker compose logs -f iseol`에 callback 오류가 있는지

### Code Review workflow 설치가 403

Discord:

```text
⚡ 연동 도우미 → 🔐 GitHub 권한 안내
```

에서 Contents / Workflows / Actions / Pull requests / Issues / Webhooks 권한을 확인하세요.

### 기존 프로젝트 채널/패널이 사라짐

프로젝트 관리자 화면의 자동 복구 또는 빠른 연동을 실행하면 저장된 ID와 실제 Discord 카테고리를 기준으로 managed resource를 재확인합니다.

---

## 개발 검증

```bash
npm ci
npm test
npm run build
git diff --check
```

테스트에는 Calendar, Scrum, GitHub identity, project migration/repair, task sync, Code Review aggregation, OAuth, setup doctor, Docker deployment contract가 포함됩니다.
