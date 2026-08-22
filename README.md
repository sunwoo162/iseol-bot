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
- Connect
- Speak
- Mention Everyone

`Manage Messages`는 안내 메시지 pin에 사용하고, `Mention Everyone`은 공모전 투표 전체 알림에 사용합니다.

다른 서버에 초대할 때는 Discord Developer Portal의 **OAuth2 → URL Generator**에서 아래 scope를 선택합니다.

- `bot`
- `applications.commands`

생성된 초대 URL로 원하는 Discord 서버에 봇을 추가하면 됩니다. Slash command는 글로벌 명령어로 등록되므로 서버별 `DISCORD_GUILD_ID` 등록은 필요하지 않습니다.

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
GITHUB_TOKEN=...
FIGMA_TOKEN=...
NOTION_TOKEN=...
```

- `DISCORD_CLIENT_ID`: Discord Application ID
- `GITHUB_TOKEN`: 두 저장소의 webhook을 만들 수 있는 GitHub token
- `DISCORD_GUILD_ID`: 선택값. 과거 길드 전용 slash command를 정리할 때만 기존 서버 ID를 잠시 유지합니다.

멀티 서버 운영에서는 각 서버의 프로젝트, 공모전, 취업 공고, 음악/음성 상태가 Discord `guildId`를 기준으로 분리됩니다.

## 4. Slash command 등록

```bash
npm install
npm run register
```

`npm run register`는 `/project`, `/contest`, `/job`, `/voice`, `/music` 명령어를 글로벌 slash command로 등록합니다.

기존 단일 서버 버전에서 사용하던 `DISCORD_GUILD_ID`가 `.env`에 남아 있으면 해당 서버에 등록되어 있던 옛 Guild slash command를 비워서 글로벌 명령어와 중복되지 않게 정리합니다. 한 번 정리한 뒤에는 `DISCORD_GUILD_ID`를 제거해도 됩니다.

Discord 글로벌 slash command는 등록 직후 모든 서버에 동시에 표시되지 않을 수 있으며 전파에 시간이 걸릴 수 있습니다.

## 5. 실행

개발용:

```bash
npm run dev
```

배포용:

```bash
npm run build
npm start
```

## 6. 사용

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

명령을 실행하면 카테고리와 프로젝트 채널을 만들고,
Discord webhook을 만든 뒤 각 GitHub repository webhook을 자동 등록합니다.

GitHub 이벤트는 Discord의 GitHub-compatible webhook endpoint로 바로 전달되므로
별도의 GitHub 이벤트 수신용 웹 서버는 필요하지 않습니다.

## 멀티 서버 동작

이설을 여러 Discord 서버에 초대해도 한 프로세스로 모두 처리합니다.

- 프로젝트 데이터는 `guildId`별로 구분
- 공모전 피드/투표는 `guildId`별로 구분
- 취업 공고 채널은 `guildId`별로 구분
- 음악 플레이리스트와 재생 상태는 `guildId`별로 구분
- 음성 공부 시간은 `guildId + userId` 기준으로 구분

한 서버에서 만든 프로젝트나 투표/플레이리스트가 다른 서버의 명령 결과에 섞이지 않도록 서버 ID를 기준으로 조회합니다.

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
