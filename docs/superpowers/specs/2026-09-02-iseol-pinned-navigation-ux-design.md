# Iseol Pinned Navigation UX Design

## Goal

Make every pinned Discord message safe and predictable by using pins only for guidance/navigation, while keeping all mutable actions in the live project hub or ephemeral panels.

## Core rule

- Pinned messages MUST NOT contain Discord custom-id action components.
- Pinned messages may contain plain text, embeds, Markdown links, and direct external URLs.
- The live `📌・프로젝트` hub remains the single persistent control surface.
- Scrum, Calendar, GitHub, review, settings, and admin actions are opened from the live hub and normally rendered ephemerally.

## Project hub

`📌・프로젝트` contains two messages:

1. A live, non-pinned control message stored as `hubPanelMessageId`.
2. A pinned navigation guide stored as `hubGuideMessageId` that links directly to the live control message.

Startup migration edits the existing stored hub panel in place, unpins it if needed, and creates/reuses the pinned guide. The live message keeps the task-first actions:

- `➕ 작업 만들기`
- `📋 내 작업`
- `📋 스크럼`
- `🐙 GitHub`
- `더보기`

## Scrum

The stored `scrumPanelMessageId` becomes the pinned scrum guide message ID. Existing pinned interactive scrum messages are edited in place to remove action buttons. The guide points users to `📌・프로젝트 → 스크럼` and includes a link to the live hub when available.

`scumPanelMessage()` remains the ephemeral interactive panel with:

- `오늘 작성/수정`
- `전날 TODO 완료 처리`
- `내 최근 기록`

## Calendar / task channel

The stored `calendarPanelMessageId` becomes the pinned Calendar/task guide message ID. Existing pinned Calendar CRUD panels are edited in place to remove custom-id controls.

The guide tells users:

- normal flow: `📌・프로젝트 → 작업 만들기`
- advanced Calendar CRUD: `📌・프로젝트 → 더보기 → 일정 관리`
- Google Calendar URL is shown as a normal Markdown/external link when configured.

The existing interactive `calendarPanel()` remains available only as an ephemeral advanced panel from the hub.

## Notion and Figma

Pinned Notion/Figma messages become navigation-only guides with no Discord components.

- Notion guide shows the connected Notion URL as a Markdown link when configured.
- Figma guide shows the connected Figma URL as a Markdown link when configured.
- If not configured, the guide points users to project management/settings in the hub.

Store optional `notionGuideMessageId` and `figmaGuideMessageId` so startup migration can update guides idempotently. When legacy projects do not have these IDs, migration may reuse a bot-authored pinned guide in the known channel or create one.

## Stored project metadata

Add optional fields:

- `hubGuideMessageId`
- `notionGuideMessageId`
- `figmaGuideMessageId`

Existing fields retain these meanings:

- `hubPanelMessageId`: live non-pinned interactive hub
- `scrumPanelMessageId`: pinned scrum navigation guide
- `calendarPanelMessageId`: pinned Calendar/task navigation guide

## Migration rules

Startup migration is idempotent and non-destructive:

1. Resolve stale project category IDs using the existing safe unique-category rule.
2. Ensure the live hub message exists and is updated; unpin it if it is currently pinned.
3. Ensure a pinned hub navigation guide exists and links to the live hub.
4. Edit/reuse the stored scrum pinned message as a navigation guide; otherwise create one.
5. Edit/reuse the stored Calendar pinned message as a navigation guide; otherwise create one.
6. Ensure Notion/Figma pinned guides without deleting user-created messages.
7. Reuse one ensured set of IDs for duplicate stored project records sharing the same resolved category.

No startup migration may delete channels, delete user messages, or expose credentials.

## Error handling

- If a live hub message cannot be resolved, a guide still explains how to find `📌・프로젝트`; it simply omits the direct message URL.
- Optional Notion/Figma/Google Calendar integrations never block the core Discord project UX.
- Raw API errors remain server-side; user-facing guidance stays concise.

## Testing

Add regression coverage proving:

- pinned payloads contain zero custom-id action components;
- live hub and ephemeral panels keep their action components;
- live hub is not pinned after ensure;
- pinned hub guide links to the live hub;
- scrum/calendar guide payloads are navigation-only;
- document guides are navigation-only;
- migration result persists/reuses all guide IDs across duplicate project records;
- existing task-first, scrum, Calendar, GitHub, and project migration tests continue to pass.
