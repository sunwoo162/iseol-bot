# Iseol Zero-ID Calendar Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make project calendar operations usable without copying Google Event IDs or typing repository selectors, while accepting short Korean-friendly date/time input.

**Architecture:** Keep `GoogleCalendarService` as the API boundary and split Discord interaction state into deterministic custom IDs plus a short-lived event-selection session map. Buttons open selects, selects resolve exact Google events or repository sides, and modals collect only human-authored content.

**Tech Stack:** Node.js 22, TypeScript, discord.js v14, Google Calendar API, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-01-iseol-zero-friction-ux-design.md`

## Global Constraints

- Users never manually copy or type a Google Event ID.
- Frontend/backend is selected, never typed, in Issue + Calendar creation.
- Accept `내일 14:00`, `9/3 14:00`, and `2026-09-03 14:00` in Asia/Seoul.
- End time is optional; omitted end defaults to one hour after start.
- Update modals are pre-filled from the selected Google event.
- Delete requires explicit confirmation after selecting an event.
- Existing calendar buttons and Google Calendar service behavior remain backward compatible at the service layer.
- All user-facing errors are concise; raw Google/GitHub errors stay in logs.

---

### Task 1: Friendly KST date/range parser

**Files:**
- Modify: `src/services/calendar/calendar-discord.ts`
- Modify: `tests/calendar-discord.test.ts`

**Interfaces:**
- Produces `parseKstDateTime(value, now?)` and `resolveCalendarRange(startText, endText, now?)`.

- [ ] Write RED tests for full date, month/day, `오늘`, `내일`, omitted end, and invalid calendar dates.
- [ ] Run `node --import tsx --test tests/calendar-discord.test.ts` and confirm failure.
- [ ] Implement parser using Asia/Seoul components; reject normalized invalid dates such as `2026-02-31`.
- [ ] Implement `resolveCalendarRange`; blank end = start + 60 minutes, and bare `HH:mm` end uses the selected start date.
- [ ] Run focused test and full `npm test`.
- [ ] Commit `feat: accept friendly calendar date input`.

### Task 2: Replace Event ID input with event select menus

**Files:**
- Modify: `src/services/calendar/google-calendar.ts`
- Modify: `src/services/calendar/calendar-discord.ts`
- Modify: `src/index.ts`
- Modify: `tests/calendar-discord.test.ts`

**Interfaces:**
- Add `GoogleCalendarService.getEvent(calendarId, eventId)`.
- Add select custom IDs `calendar_event:update:<projectId>` and `calendar_event:delete:<projectId>`.
- Add `handleCalendarSelect(interaction): Promise<boolean>`.

- [ ] Write RED tests for event-select custom ID parsing and event option rendering without exposing IDs in labels/descriptions.
- [ ] Implement `getEvent` and event select payload limited to upcoming 25 events.
- [ ] Update `calendar:update` / `calendar:delete` button paths to show event selects instead of Event-ID modals.
- [ ] Add a short-lived in-memory selection token `{ projectId, eventId, action, expiresAt }` so event IDs do not need to be typed or embedded in modal IDs.
- [ ] Route string select interactions in `src/index.ts`.
- [ ] Verify tests/build/diff-check.
- [ ] Commit `feat: select calendar events instead of event ids`.

### Task 3: Pre-filled update and confirmed delete

**Files:**
- Modify: `src/services/calendar/calendar-discord.ts`
- Modify: `src/index.ts`
- Modify: `tests/calendar-discord.test.ts`

**Interfaces:**
- Update selection opens `calendar_update_selected_modal:<token>` with title/start/end values populated.
- Delete selection responds with confirmation buttons `calendar_delete_confirm:<token>` / `calendar_delete_cancel:<token>`.

- [ ] Write RED tests for selected-event session resolution and delete confirmation semantics.
- [ ] Implement update modal prefill using `getEvent` and readable KST formatting.
- [ ] Make update submit resolve exact event ID through token state.
- [ ] Make delete selection non-destructive until confirm button is clicked.
- [ ] Add confirm/cancel button routing through `handleCalendarButton`.
- [ ] Verify focused/full tests, build, diff-check.
- [ ] Commit `feat: confirm calendar edits by selected event`.

### Task 4: Replace Issue repository text with select menu

**Files:**
- Modify: `src/services/calendar/calendar-discord.ts`
- Modify: `tests/calendar-discord.test.ts`

**Interfaces:**
- Add select ID `calendar_issue_repo:<projectId>` with values `frontend` and `backend`.
- `calendar:issue` displays the repository select.
- Selected side opens `calendar_issue_modal:<projectId>:<side>`; modal contains title/body/start/optional end only.

- [ ] Write RED test that the Issue flow exposes exactly frontend/backend select choices and has no repository text input.
- [ ] Implement repository select and modal routing.
- [ ] Use `resolveCalendarRange` in add/update/issue submit paths.
- [ ] Remove Event ID from success copy; show title/link only.
- [ ] Run full `npm test`, `npm run build`, `git diff --check`.
- [ ] Commit `feat: simplify issue calendar creation`.

## Completion gate

Run the temporary feature verification workflow against the final Phase 2 HEAD and require `npm ci`, `npm test`, `npm run build`, and `git diff --check` to succeed before moving to Phase 3.
