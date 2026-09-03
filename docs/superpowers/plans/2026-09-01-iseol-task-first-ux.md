# Iseol Task-First UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Discord `작업` the primary user-facing project primitive and automatically synchronize each task with GitHub Issues and Google Calendar.

**Architecture:** Add a small persisted task-state service, a Discord task UI service, and GitHub issue mutation methods. Reuse the existing KST date parser and Google Calendar service instead of replacing Calendar code. Project hub becomes task-first while existing Calendar/slash-command paths remain available behind an advanced action.

**Tech Stack:** TypeScript, Node 22, discord.js 14, Octokit REST, Google Calendar API, node:test.

**Spec:** `docs/superpowers/specs/2026-09-01-iseol-task-first-ux-design.md`

## Global Constraints

- Runtime `data/` is untracked and must never be deleted by deployment.
- Existing `/project`, `/github`, `/scrum` and `calendar:*` flows remain compatible.
- Never display or accept GitHub PAT, Google OAuth credentials, or Discord secrets in task UI.
- Default task repository is the project's frontend repository.
- Google Calendar is optional/degradable; a Calendar failure must not delete an already-created GitHub Issue.
- PR #39 remains open and unmerged unless explicitly requested.

---

### Task 1: Persist linked project tasks

**Files:**
- Create: `src/services/project-task.ts`
- Create: `tests/project-task.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `StoredProjectTask`, `saveProjectTask`, `findProjectTask`, `updateProjectTask`, `listProjectTasks`, `listMemberProjectTasks`.

- [ ] **Step 1: Write the failing test** verifying save/update/find and guild/project/member scoped listing.
- [ ] **Step 2: Run `npm test` and verify failure because `project-task.ts` is absent.**
- [ ] **Step 3: Implement JSON persistence at `data/project-tasks.json` using UTF-8 and generated stable IDs.**
- [ ] **Step 4: Run full `npm test`, `npm run build`, and `git diff --check`.**
- [ ] **Step 5: Commit `feat: add linked project task state`.**

### Task 2: Add GitHub Issue update/close operations

**Files:**
- Modify: `src/services/github.ts`
- Create: `tests/github-task.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `updateIssue(repository, issueNumber, { title?, body?, state? })` and `closeIssue(repository, issueNumber)`.

- [ ] **Step 1: Write failing contract tests around task issue mutation payload normalization.**
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Add Octokit issue mutation methods without changing existing `createIssue`.**
- [ ] **Step 4: Verify all tests/build/diff-check.**
- [ ] **Step 5: Commit `feat: add task issue mutations`.**

### Task 3: Build task IDs, cards, and create modal

**Files:**
- Create: `src/services/project-task-discord.ts`
- Create: `tests/project-task-discord.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `buildProjectTaskId`, `parseProjectTaskId`, `taskCardPayload`, `taskCreateModal`, `taskEditModal`, `memberTaskSummary`.

- [ ] **Step 1: Write RED tests for custom IDs, three-button task card, minimal create modal, completed-card rendering, and member filtering.**
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement pure Discord payload builders; create modal contains title, due/start, optional description only.**
- [ ] **Step 4: Verify GREEN plus build/diff-check.**
- [ ] **Step 5: Commit `feat: add task-first discord UI`.**

### Task 4: Create a task with automatic GitHub + Calendar + Discord synchronization

**Files:**
- Modify: `src/services/project-task-discord.ts`
- Modify: `src/index.ts`
- Modify: `tests/project-task-discord.test.ts`

**Interfaces:**
- `handleProjectTaskButton(interaction)` handles create/my/open/complete/edit/more.
- `handleProjectTaskModal(interaction)` handles create/edit modal submissions.

- [ ] **Step 1: Write RED tests for create planning: frontend default, creator identity, one-hour default duration, Calendar optional degradation.**
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: On create modal submit, find project, parse date with existing `resolveCalendarRange`, create GitHub Issue, attempt Calendar event, save task, send Discord card in `calendarChannelId`, then persist message ID.**
- [ ] **Step 4: Route `project_task:*` buttons/modals in `src/index.ts`.**
- [ ] **Step 5: Verify full test/build/diff-check and commit `feat: create synced project tasks`.**

### Task 5: Complete and edit tasks without IDs

**Files:**
- Modify: `src/services/project-task-discord.ts`
- Modify: `src/services/project-task.ts`
- Modify: `tests/project-task-discord.test.ts`

**Interfaces:**
- Completion closes GitHub issue, optionally updates Calendar event with `✅`, updates stored status, edits existing card.
- Edit updates GitHub issue title/body, optionally Calendar summary/time, state, and existing card.

- [ ] **Step 1: Write RED tests for idempotent completion and prefilled edit defaults.**
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement complete/edit mutation flow using stored identities only.**
- [ ] **Step 4: Verify full test/build/diff-check.**
- [ ] **Step 5: Commit `feat: manage synced tasks from discord`.**

### Task 6: Make the project hub task-first

**Files:**
- Modify: `src/services/project-experience/project-custom-id.ts`
- Modify: `src/services/project-experience/project-hub.ts`
- Modify: `tests/project-experience.test.ts`

**Interfaces:**
- Hub primary row: `➕ 작업 만들기`, `📋 내 작업`, `📋 스크럼`, `🐙 GitHub`, `⋯ 더보기`.
- `더보기` exposes existing Calendar, review, refresh, and admin controls.

- [ ] **Step 1: Write RED tests for the new primary action set and advanced compatibility access.**
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Update hub custom IDs/payload/handler to delegate task actions and hide direct Calendar CRUD from the primary row.**
- [ ] **Step 4: Verify full test/build/diff-check.**
- [ ] **Step 5: Commit `feat: make project hub task first`.**

### Task 7: Ensure old projects can host task cards

**Files:**
- Modify: `src/services/project-experience/project-migration.ts`
- Modify: `tests/project-migration.test.ts`

**Interfaces:**
- Existing project experience migration ensures/reuses `📅・일정` and its panel when missing, without deleting duplicate records.

- [ ] **Step 1: Write RED test for missing Calendar channel metadata requiring safe ensure.**
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Extend project experience ensure to find/create exactly one managed `📅・일정` channel and panel, storing IDs idempotently.**
- [ ] **Step 4: Verify full test/build/diff-check.**
- [ ] **Step 5: Commit `fix: recover task calendar channel`.**

### Task 8: Final verification and temporary CI cleanup

**Files:**
- Temporary: `.github/workflows/task-first-verify.yml` only while connector-side development needs CI execution.

- [ ] **Step 1: Run fresh `npm ci`, complete `npm test`, `npm run build`, `git diff --check` in GitHub Actions.**
- [ ] **Step 2: Confirm no tracked `data/` or secret files were added.**
- [ ] **Step 3: Remove temporary verification workflow after a GREEN source commit.**
- [ ] **Step 4: Update PR #39 description with task-first behavior and validation SHA; do not merge.**
