# Discord Project Automation Bot

프로젝트를 만들 때 Discord 구조와 Notion / Figma / GitHub 연결을 한 번에 생성하는 봇입니다.

## 생성되는 구조

```text
📁 프로젝트명
├─ 📌・프로젝트
├─ 📄・기능명세서
├─ 🎨・figma
├─ 💻・frontend-log
└─ 🛠・backend-log
```

`frontend-log`에는 프론트엔드 저장소 GitHub 이벤트가,
`backend-log`에는 백엔드 저장소 GitHub 이벤트가 자동으로 들어옵니다.

현재 연결 이벤트:

- push
- pull_request
- issues
- issue_comment
- release
- check_run
- check_suite

## 1. Discord Bot 준비

Discord Developer Portal에서 애플리케이션과 Bot을 생성합니다.

봇에 최소한 아래 권한이 필요합니다.

- View Channels
- Send Messages
- Embed Links
- Manage Channels
- Manage Webhooks
- Manage Messages

`Manage Messages`는 안내 메시지 pin에 사용합니다.

## 2. GitHub Token 준비

GitHub Fine-grained personal access token을 만들고 대상 프론트/백엔드 저장소에 접근 권한을 부여합니다.

필수 repository permission:

- Webhooks: Read and write

프로젝트 저장소가 private이면 해당 저장소 자체에 대한 접근도 허용되어 있어야 합니다.

## 3. 환경변수

`.env.example`을 `.env`로 복사합니다.

```env
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
GITHUB_TOKEN=...
```

- `DISCORD_CLIENT_ID`: Discord Application ID
- `DISCORD_GUILD_ID`: 봇을 사용할 Discord 서버 ID
- `GITHUB_TOKEN`: 두 저장소의 webhook을 만들 수 있는 GitHub token

## 4. 실행

```bash
npm install
npm run register
npm run dev
```

배포용:

```bash
npm run build
npm start
```

## 5. 사용

Discord에서 다음 slash command를 실행합니다.

```text
/project create
```

입력 항목:

```text
name      프로젝트 이름
notion    기능명세서 Notion URL
figma     Figma URL
frontend  프론트엔드 GitHub URL 또는 owner/repo
backend   백엔드 GitHub URL 또는 owner/repo
```

예시:

```text
/project create
name: Rain GJ
notion: https://www.notion.so/...
figma: https://www.figma.com/design/...
frontend: team/rain-gj-frontend
backend: team/rain-gj-backend
```

명령을 실행하면 카테고리와 5개 채널을 만들고,
Discord webhook을 만든 뒤 각 GitHub repository webhook을 자동 등록합니다.

GitHub 이벤트는 Discord의 GitHub-compatible webhook endpoint로 바로 전달되므로
별도의 GitHub 이벤트 수신용 웹 서버는 필요하지 않습니다.

## 주의

ChatGPT에서 연결한 Notion/Figma/GitHub 계정과 실제 Discord Bot 런타임의 인증은 별개입니다.
이 봇은 현재 Notion/Figma의 내용을 직접 생성하지 않고, slash command로 받은 링크를 Discord에 고정합니다.

기능명세서 페이지 자체를 Notion에 자동 생성하거나 Figma 프로젝트/파일을 자동 생성하는 기능은
각 서비스 API 인증을 별도로 붙여 확장할 수 있습니다.


## v2 입력 제한 / Organization 참여

- Notion: `https://www.notion.so/...` 또는 `https://*.notion.site/...` 실제 페이지 링크만 허용
- Figma: `https://www.figma.com/design/...`, `/file/...`, `/board/...`, `/proto/...`만 허용
- GitHub: `https://github.com/ORG/REPO` 형식만 허용
- Frontend/Backend는 반드시 같은 GitHub Organization 아래에 있어야 함
- 프로젝트 채널의 `GitHub Organization 참여` 버튼 → GitHub 사용자명 입력 → Organization 초대 자동 발송
- GitHub 토큰에는 기존 Webhooks 쓰기 권한 외에 Organization Members 쓰기 권한이 필요함
