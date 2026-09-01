# Iseol Zero-Friction Project UX Design

Date: 2026-09-01
Status: proposed / user direction approved
Scope: Discord project setup and everyday project operations

## Goal

Make Iseol usable without memorizing slash-command syntax. Administrators should configure a project once, and ordinary members should perform most recurring work from pinned Discord panels using buttons, select menus, and short modals.

The system should automate deterministic setup and synchronization, but must not guess destructive or identity-sensitive values.

## Current friction

The current flow requires users to remember several commands and manually copy values between screens:

- `/project create` requires project name, Notion URL, Figma URL, frontend repository, and backend repository as command options.
- `/github connect` requires a separate command and repeated GitHub username entry in project-join flows.
- `/scrum write` is the main daily entry point even though the project already has a dedicated channel.
- Calendar update/delete requires copying an Event ID from the list and pasting it into another modal.
- GitHub Issue + Calendar creation asks users to type `frontend` or `backend` instead of choosing one.
- Integration failures such as missing workflow permissions appear mostly as server logs rather than an actionable project status.

## UX principles

1. **One obvious home**: `📌・프로젝트` contains a pinned Iseol project hub.
2. **Buttons before commands**: commands remain as compatibility/power-user paths, not the primary UX.
3. **Select before typing identifiers**: users should choose projects, repositories, events, and actions instead of copying IDs.
4. **One-time identity input**: a GitHub username is entered once per Discord server and reused for project invitations/profile actions.
5. **Automatic deterministic setup**: channels, panels, scrum, calendar, review workflow, and polling are created or repaired automatically when configuration permits.
6. **Partial setup is allowed**: missing Notion/Figma/Calendar credentials must not block creation of the rest of the project.
7. **No unsafe guessing**: Iseol may derive organization from validated repositories, but must not guess repository identity, GitHub user identity, or destructive targets.
8. **Human-readable errors**: ordinary users see a short fix-oriented message; raw API errors stay in server logs.

## Approaches considered

### A. Keep command-centric UX and improve autocomplete

Smallest code change, but users still need to know which command to invoke and how the command hierarchy is organized. This does not meet the zero-friction goal.

### B. Project hub + progressive panels — recommended

Use a pinned project hub as the main entry point. Buttons open small ephemeral action panels; select menus resolve concrete targets; modals collect only free-form text. Existing commands remain for compatibility.

This gives the best balance of discoverability, implementation safety, and reuse of the current services.

### C. Central DM/global dashboard

A bot-wide dashboard could manage all projects, but it removes useful project-channel context and requires more complex cross-guild/project state. This is deferred.

## Project setup flow

### Primary entry point

`/project create` remains available but no longer exposes five required slash-command options.

Running the command opens a setup modal containing:

- Project name — required
- Frontend repository — required
- Backend repository — required
- Notion URL — optional
- Figma URL — optional

Frontend/backend remain required in this iteration because the existing project model and log/review system are built around two repositories. One-repository projects are a later extension.

### Validation and inference

After submit, Iseol:

1. validates both GitHub repositories,
2. verifies they share the same Organization,
3. derives the Organization automatically,
4. validates optional Notion/Figma links only when supplied,
5. checks for an existing project with the same guild + repository pair before creating a duplicate.

### Automatic setup

Iseol then creates/ensures:

- project category,
- `📌・프로젝트`,
- `📄・기능명세서`,
- `🎨・figma`,
- `💬・토론`,
- `🗓・데일리스크럼`,
- `💻・frontend-log`,
- `🛠・backend-log`,
- `📅・일정`,
- project hub panel,
- scrum panel,
- calendar panel,
- GitHub event webhooks where configured,
- Iseol code-review workflow where token permissions allow,
- Google Calendar where OAuth is configured,
- optional Notion/Figma integrations where links are supplied.

An optional integration failure does not roll back the whole project. The final setup response lists successful and incomplete integrations.

## Project hub

`📌・프로젝트` contains one pinned message that acts as the project dashboard.

### Status area

The embed shows compact health states:

- GitHub repositories
- Code Review
- Google Calendar
- Scrum
- Notion
- Figma

Suggested state language:

- `✅ 연결됨`
- `⚠️ 설정 필요`
- `⏳ 확인 중`
- `❌ 복구 필요`

Raw HTTP/API messages are never placed in this embed.

### Member actions

First row:

- `📅 일정`
- `📋 스크럼`
- `🐙 GitHub`
- `🔍 리뷰 상태`
- `🔄 새로고침`

Second row contains link buttons when available:

- `📄 Notion 열기`
- `🎨 Figma 열기`
- `🐙 Frontend`
- `🐙 Backend`

Project membership/invite is exposed through the GitHub panel rather than requiring another username modal every time.

### Admin actions

A second ephemeral admin panel is available only to members with channel-management permission:

- `⚙️ 연동 설정`
- `🔧 자동 복구`
- `🗑️ 프로젝트 삭제`

Destructive deletion requires an explicit confirmation step.

## Calendar UX

The existing `📅・일정` channel remains, but the project hub can open the same controls ephemerally.

### Add schedule

`일정 추가` opens a modal with:

- title,
- start,
- optional end.

Accepted date/time input expands beyond the rigid full timestamp to common Korean-friendly forms such as:

- `내일 14:00`
- `9/3 14:00`
- `2026-09-03 14:00`

If end is omitted, default to one hour after start.

### View

Upcoming events are rendered with readable date/time and title. Internal Google Event IDs are not shown unless diagnostics are requested.

### Update/delete

No Event ID copy/paste.

The user clicks update/delete, receives a select menu populated with upcoming events, chooses one, and then:

- update opens a pre-filled edit modal,
- delete shows a confirmation action.

### GitHub Issue + schedule

The user first chooses Frontend or Backend from a select menu. The following modal asks only for issue/schedule content. The repository selector is never a free-form text field.

## Scrum UX

`🗓・데일리스크럼` is created automatically with the project.

A pinned scrum panel provides:

- `✍️ 오늘 작성/수정`
- `✅ 전날 TODO 완료 처리`
- `📖 내 최근 기록`

The write modal is pre-filled with today's existing values when editing.

The scrum panel shows yesterday's TODO before the user chooses how to write today's record. `전날 TODO 완료 처리` opens the write flow with yesterday's TODO prepared as DID, but the user still confirms before saving.

`/scrum write` remains available for users who prefer commands.

## GitHub member UX

The project hub's GitHub action opens an ephemeral account panel.

### Not linked

Show one button: `GitHub 계정 연결`.

The button opens the username modal. Once validated, the mapping is stored at guild + Discord user level.

### Linked

Show:

- linked account,
- profile button,
- project Organization join button,
- disconnect button.

When joining a project Organization, reuse the stored GitHub username. Do not ask for the username again.

If the user is not linked and chooses project join, run the connect flow first and then continue the invitation flow.

## Code-review UX

Code review remains fully automatic after repository setup.

The hub's `리뷰 상태` action shows:

- Frontend workflow installed / needs setup
- Backend workflow installed / needs setup
- latest known review run state when available
- last actionable Iseol review summary when available

Users do not manually start normal reviews.

For public repositories use GitHub-hosted `ubuntu-latest`; for private repositories use the isolated `iseol-review` self-hosted runner.

If workflow installation fails due to token permission, ordinary members see `관리자 설정 필요`; admins receive a concise permission checklist rather than the raw 403 response.

## Integration settings

The admin `연동 설정` panel lets integrations be added later without recreating the project.

Initial targets:

- Notion link
- Figma link
- Calendar connection status
- GitHub review workflow status

Notion and Figma are optional at project creation. Their channel exists even when unconfigured and displays a setup button instead of an error.

Global secrets such as Google OAuth credentials and GitHub PAT remain server-admin configuration and are never entered through Discord.

## Automatic diagnostics and repair

Introduce a project experience/health service that can inspect and ensure deterministic resources.

`자동 복구` and startup migration may safely:

- recreate missing managed channels,
- recreate missing pinned Iseol panels,
- refresh stored panel message IDs,
- install a missing review workflow without overwriting an existing file,
- recreate a missing project calendar only when the project has no stored calendar and global OAuth is available,
- re-establish optional integrations only when their stored source URL exists.

It must not:

- delete user-created channels,
- overwrite an existing repository workflow,
- replace repository URLs by guessing,
- remove duplicate project records automatically,
- expose server credentials.

Exact duplicate repository pairs are deduplicated for background installation attempts, but data cleanup remains an explicit admin operation.

## Architecture

Add focused services instead of growing `index.ts` or `project.ts` further.

Suggested modules:

- `services/project-experience/project-hub.ts` — render hub + route hub actions
- `services/project-experience/project-setup.ts` — setup orchestration and partial-success result
- `services/project-experience/project-health.ts` — health model and checks
- `services/project-experience/project-repair.ts` — safe idempotent repair operations
- `services/project-experience/project-custom-id.ts` — parse/build stable interaction IDs
- `services/calendar/calendar-discord.ts` — retain calendar-specific UI, replace ID typing with selects
- `services/daily-scrum-discord.ts` — panel and modal UI around existing scrum persistence
- `services/github-account-discord.ts` — reusable account connect/profile/join panel

`index.ts` should only dispatch interaction families to these handlers.

## Stored project changes

Extend `StoredProject` with optional managed-message metadata:

- `hubPanelMessageId?: string`
- `scrumChannelId?: string`
- `scrumPanelMessageId?: string`

Existing optional Notion/Figma fields remain valid, enabling partial setup.

No incompatible JSON migration is required because all new fields are optional.

## Interaction IDs

Use a consistent namespace:

- `project_hub:<action>:<projectId>`
- `project_admin:<action>:<projectId>`
- `project_github:<action>:<projectId>`
- `project_scrum:<action>:<projectId>`
- `calendar:<action>:<projectId>`

Select-menu values may contain repository side or external IDs, but external IDs are never manually typed by users.

## Error handling

Every user-facing failure maps to one of:

- `다시 시도해주세요`
- `관리자 설정이 필요합니다`
- `연결 정보를 찾을 수 없습니다`
- `권한이 없습니다`

The detailed exception is logged with project/repository context server-side.

Partial project setup returns a checklist rather than a generic failure.

## Permissions

- Project creation/deletion/repair/settings: `ManageChannels`
- Calendar ordinary actions: project members
- Scrum write/profile/review status: project members
- Organization invite: project members with linked GitHub identity, subject to GitHub token permissions
- Secrets/global credentials: never editable from Discord

## Backward compatibility

Keep existing slash commands during migration:

- `/project create`
- `/project delete`
- `/github connect|profile|disconnect`
- `/scrum create|write|delete`

The UI routes call the same underlying services so behavior does not split into separate implementations.

`/scrum create` becomes unnecessary for newly created projects but remains useful for legacy projects until migration completes.

## Startup migration

On bot ready:

1. enumerate stored projects,
2. detect missing managed channels/panels,
3. ensure hub and scrum experience idempotently,
4. refresh the hub health display,
5. keep existing background GitHub/Calendar polling unchanged.

Migration failures are isolated per project and do not prevent the bot from starting.

## Delivery phases

### Phase 1 — Project hub and automatic project setup

- setup modal
- optional Notion/Figma
- automatic scrum channel
- pinned hub
- health summary
- duplicate repository-pair prevention

### Phase 2 — Calendar zero-ID workflow

- event select menus
- edit prefill
- delete confirmation
- repository select for Issue + schedule
- friendly date parser and default duration

### Phase 3 — Scrum and GitHub account panels

- scrum pinned panel
- button-driven write/edit
- previous TODO helper
- one-time GitHub connect
- stored identity reused for project join

### Phase 4 — Diagnostics, repair, and migration

- integration health checks
- admin settings panel
- safe auto repair
- startup migration for existing projects
- concise actionable permission errors

## Testing

Use TDD for each interaction domain.

Required coverage includes:

- setup modal parsing and optional integrations,
- duplicate project/repository pair rejection,
- hub custom ID parsing,
- permission checks,
- health rendering,
- calendar relative date parsing,
- calendar selection maps to exact Event ID,
- delete confirmation does not delete before confirmation,
- issue repository selection maps to exact frontend/backend repo,
- scrum existing-record prefill,
- GitHub linked username reuse,
- repair idempotency,
- startup migration does not duplicate channels/panels,
- legacy slash-command behavior remains valid.

Before deployment run full `npm test`, `npm run build`, and `git diff --check`.

## Success criteria

For a normal project member:

- no command needs to be memorized after project creation,
- no Google Event ID is ever copied manually,
- `frontend`/`backend` is selected rather than typed,
- GitHub username is entered at most once per Discord server,
- daily scrum can be completed from the project channel using buttons,
- code review runs automatically after setup.

For an administrator:

- project creation starts from one command and one modal,
- missing optional integrations do not block setup,
- project status clearly shows what still needs configuration,
- safe resources can be repaired with one action,
- server secrets remain outside Discord.
