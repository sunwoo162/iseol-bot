# Iseol Task-First UX Design

## Goal

Turn Discord into the primary project-management UI. Members think in terms of a single `작업`; Iseol automatically maintains the linked GitHub Issue and Google Calendar event.

## Member UX

Pinned project hub primary actions:

- `➕ 작업 만들기`
- `📋 내 작업`
- `📋 스크럼`
- `🐙 GitHub`
- `⋯ 더보기`

The advanced menu exposes Calendar CRUD, code-review status, refresh, and admin functions. Existing slash commands and Calendar handlers remain compatible.

### Create task

Default modal fields:

- title (required)
- due/start text (required; existing KST-friendly parser)
- optional description

Defaults:

- repository: project frontend repository
- assignee identity: Discord creator; linked GitHub username is used when available
- duration: one hour
- status: open
- GitHub Issue creation: automatic
- Google Calendar event creation: automatic when Calendar is configured
- Discord task card: automatic in `📅・일정`

If Google Calendar is not configured, GitHub Issue + Discord card still succeed and the card shows Calendar as unavailable. A Calendar integration failure must not roll back an already-created GitHub Issue.

### Task card

Card content:

- title
- creator/assignee mention
- due time
- GitHub repository + Issue number/link
- status

Primary actions:

- `✅ 완료`
- `✏️ 수정`
- `⋯`

`✅ 완료` closes the GitHub Issue, updates the linked Calendar event title with a completion marker when present, and edits the Discord card to completed. Repeated completion is idempotent.

`✏️ 수정` opens a prefilled modal for title/description/due time. The update is applied to GitHub Issue, linked Calendar event, local task state, and the existing Discord card.

### My tasks

`📋 내 작업` shows the member's open tasks for the current project, newest/due-soon items first, with links to the corresponding Discord task cards or GitHub Issues. It never shows another member's tasks as the user's own.

## State

Persist task links in `data/project-tasks.json` with stable Iseol task IDs. Store project ID, Discord creator ID, optional linked GitHub username, repository side, issue number/url, optional calendar event ID, Discord channel/message IDs, title, body, start/end, status, and timestamps.

Runtime `data/` remains untracked and must never be deleted by deployment.

## Compatibility

- Existing `calendar:*` flows remain available through advanced UI.
- Existing `/project`, `/github`, `/scrum` remain available.
- Existing Calendar issue creation remains supported, but the task-first path becomes the recommended path.
- PR #39 remains open/unmerged until explicitly requested.

## Safety / reliability

- Never expose PAT/OAuth/Discord secrets.
- No destructive startup migration of task records.
- GitHub Issue creation is the primary external write; Calendar is optional/degradable.
- Completion and edit operations use stored project/repository/issue identities; users do not type IDs.
- Buttons validate guild/project/task ownership context before writes.
- Task mutations are idempotent where practical.
