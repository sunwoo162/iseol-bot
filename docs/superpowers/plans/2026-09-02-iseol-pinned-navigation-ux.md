# Iseol Pinned Navigation UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every pinned Discord message navigation-only while preserving a live task-first project hub and ephemeral action panels.

**Architecture:** Split persistent project control from pinned guidance. `hubPanelMessageId` remains the live non-pinned interactive message, while new guide IDs track pinned navigation-only messages; Scrum and Calendar keep their interactive payload builders only for ephemeral hub flows while their stored pinned message IDs are repurposed as guide messages.

**Tech Stack:** TypeScript, discord.js, Node test runner, GitHub Actions verification.

**Spec:** `docs/superpowers/specs/2026-09-02-iseol-pinned-navigation-ux-design.md`

## Global Constraints

- Pinned messages contain no custom-id action components.
- Startup migration is idempotent and never deletes channels or user messages.
- Existing task-first hub, Calendar CRUD, Scrum, GitHub, review, settings, and admin flows remain compatible.
- Optional integrations must not block core Discord UX.
- PR #39 remains open and unmerged.

---

### Task 1: Navigation-only payload contracts

**Files:**
- Create: `src/services/project-experience/project-navigation-guides.ts`
- Modify: `src/services/projects.ts`
- Test: `tests/project-navigation-guides.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `discordMessageUrl(guildId, channelId, messageId): string`.
- Produces `projectHubPinnedGuide(project, hubUrl?)`.
- Produces `calendarPinnedGuide(project, hubUrl?)`.
- Produces `documentPinnedGuide(project, kind, hubUrl?)`.
- Adds optional `hubGuideMessageId`, `notionGuideMessageId`, `figmaGuideMessageId` to `StoredProject`.

- [ ] Write tests asserting every guide payload has zero components and includes expected navigation copy/links.
- [ ] Run the new test and confirm RED because guide helpers do not exist.
- [ ] Implement the minimal guide payload builders and metadata fields.
- [ ] Add the new test to `npm test` and run the focused test to GREEN.
- [ ] Commit as small `feat:`/`test:` commits.

### Task 2: Separate live hub from pinned hub guide

**Files:**
- Modify: `src/services/project-experience/project-hub.ts`
- Test: `tests/project-experience.test.ts`

**Interfaces:**
- `ensureProjectHub(channel, project, health)` continues to return the live hub message ID but must unpin that live message when needed.
- Add `ensureProjectHubGuide(channel, project, hubMessageId): Promise<string>` that creates/edits/pins the navigation-only guide.

- [ ] Add RED tests for live hub remaining interactive and pinned guide remaining component-free.
- [ ] Implement live-message unpinning plus pinned guide ensure.
- [ ] Verify hub tests GREEN without changing the task-first actions.
- [ ] Commit.

### Task 3: Convert Scrum, Calendar, Notion and Figma pins to guides

**Files:**
- Modify: `src/services/daily-scrum-discord.ts`
- Modify: `src/services/project-experience/project-migration.ts`
- Modify: `src/services/project-experience/project-setup.ts`
- Test: `tests/daily-scrum-discord.test.ts`
- Test: `tests/project-migration.test.ts`
- Test: `tests/project-setup.test.ts`

**Interfaces:**
- `scrumPanelMessage(project)` stays the ephemeral action panel.
- `scrumPinnedGuideMessage(project, hubUrl?)` becomes the payload used by the stored pinned Scrum message.
- Calendar pinned message uses `calendarPinnedGuide()`; `calendarPanel()` remains ephemeral-only.
- Notion/Figma setup and migration use `documentPinnedGuide()` and persist guide IDs when available.

- [ ] Extend existing Scrum RED coverage so the stored pin payload has no action components while `scrumPanelMessage` still exposes three actions.
- [ ] Add RED migration/setup tests for Calendar/document guide IDs.
- [ ] Change existing pinned messages in place where IDs exist; otherwise create and pin guides.
- [ ] For legacy Notion/Figma channels without guide IDs, reuse a bot-authored pinned message when safely identifiable or create a new guide without deleting anything.
- [ ] Run focused tests to GREEN.
- [ ] Commit by responsibility.

### Task 4: Startup migration and duplicate reuse

**Files:**
- Modify: `src/services/project-experience/project-migration.ts`
- Test: `tests/project-migration.test.ts`

**Interfaces:**
- `ProjectExperienceEnsureResult` includes `hubGuideMessageId`, `notionGuideMessageId`, and `figmaGuideMessageId` in addition to existing IDs.
- Duplicate stored projects sharing one resolved category reuse the same live hub and pinned guide IDs.

- [ ] Add RED tests showing ensured guide IDs are copied to duplicate project records.
- [ ] Update `applyEnsuredProjectExperience` and startup ensure flow to persist/reuse all guide IDs.
- [ ] Verify stale-category recovery still selects a valid canonical record first.
- [ ] Run migration tests to GREEN.
- [ ] Commit.

### Task 5: Full verification and cleanup

**Files:**
- Temporary only if needed: `.github/workflows/pinned-navigation-verify.yml`
- Update: PR #39 body after GREEN validation.

- [ ] Run `npm ci`.
- [ ] Run full `npm test` and require zero failures.
- [ ] Run `npm run build` and require success.
- [ ] Run `git diff --check` and require success.
- [ ] Remove any temporary verification workflow after the GREEN source run.
- [ ] Confirm the cleanup commit changes only the temporary workflow.
- [ ] Update PR #39 validation notes without merging it.
