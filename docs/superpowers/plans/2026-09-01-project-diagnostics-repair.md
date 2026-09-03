# Project Diagnostics and Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give project admins a human-readable integration health panel, safe one-click repair for deterministic resources, editable optional Notion/Figma links, and startup health refresh without exposing secrets or raw API errors.

**Architecture:** Keep `StoredProject` as the source of persisted integration metadata. Centralize health derivation in `project-health.ts`, put admin UI and interaction parsing in focused project-experience services, and reuse existing `ensureProjectExperience()` plus `ensureProjectReviewWorkflows()` for repair rather than duplicating setup logic. Startup migration continues to be idempotent and isolated per project.

**Tech Stack:** TypeScript, discord.js 14, Octokit/GitHub services already in the repo, Node test runner, existing JSON persistence.

**Spec:** `docs/superpowers/specs/2026-09-01-iseol-zero-friction-ux-design.md`

## Global Constraints

- Project creation/deletion/repair/settings require Discord `ManageChannels`.
- Never expose GitHub PAT, Google OAuth credentials, Discord secrets, raw 403 bodies, or other server credentials in Discord.
- Notion and Figma remain optional integrations.
- Repair may recreate managed channels/panels and install a missing review workflow without overwriting an existing workflow.
- Repair must not delete user-created channels, guess repository URLs, auto-delete duplicate project records, or overwrite existing repository workflows.
- Existing slash commands remain compatible.
- Every task follows RED → GREEN → full regression verification.

---

### Task 1: Centralize stored project health diagnostics

**Files:**
- Modify: `src/services/project-experience/project-health.ts`
- Modify: `src/services/project-experience/project-hub.ts`
- Modify: `src/services/project-experience/project-migration.ts`
- Test: `tests/project-experience.test.ts`

**Interfaces:**
- Produces: `storedProjectHealth(project: StoredProject): ProjectHealth`
- Produces: `projectHealthIssues(health: ProjectHealth): string[]`

- [ ] **Step 1: Write the failing test**

Add tests proving a project with both webhook IDs, calendar ID, scrum channel/panel IDs, optional links, and review workflow metadata renders connected states; missing deterministic resources render `repair`; missing optional links render `needs_setup`; user-facing issue lines never contain raw HTTP text.

- [ ] **Step 2: Run test to verify it fails**

Run the repository test workflow and confirm failure is caused by missing exported health helpers.

- [ ] **Step 3: Write minimal implementation**

Move duplicated stored health derivation out of `project-hub.ts` and `project-migration.ts` into `project-health.ts`. Keep copy limited to the existing state vocabulary: `connected`, `needs_setup`, `needs_admin`, `checking`, `repair`.

- [ ] **Step 4: Run test to verify it passes**

Run full `npm test`, `npm run build`, and `git diff --check`.

- [ ] **Step 5: Commit**

Commit message: `feat: centralize project health diagnostics`

---

### Task 2: Add admin panel interaction contract

**Files:**
- Create: `src/services/project-experience/project-admin.ts`
- Modify: `src/services/project-experience/project-hub.ts`
- Modify: `src/index.ts`
- Create: `tests/project-admin.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `buildProjectAdminId(action, projectId)`
- Produces: `parseProjectAdminId(customId)`
- Produces: `projectAdminPanel(project, health)`
- Produces: `handleProjectAdminButton(interaction, client)`

Admin actions:
- `settings`
- `repair`
- `refresh`

- [ ] **Step 1: Write the failing test**

Assert round-trip custom IDs and that the admin panel contains `연동 설정`, `자동 복구`, and `상태 새로고침`, with no destructive delete action in this panel.

- [ ] **Step 2: Run test to verify it fails**

Confirm missing module/exports cause RED.

- [ ] **Step 3: Write minimal implementation**

Create the panel and route `project_hub:admin:*` to it for `ManageChannels` users only. Unauthorized users receive `권한이 없습니다`.

- [ ] **Step 4: Run test to verify it passes**

Run full test/build/diff-check workflow.

- [ ] **Step 5: Commit**

Commit message: `feat: add project admin diagnostics panel`

---

### Task 3: Implement safe idempotent repair orchestration

**Files:**
- Create: `src/services/project-experience/project-repair.ts`
- Modify: `src/services/project-experience/project-admin.ts`
- Modify: `src/services/project-experience/project-migration.ts`
- Create: `tests/project-repair.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `repairProject(client, project, github): Promise<ProjectRepairResult>`
- `ProjectRepairResult` contains compact `repaired[]`, `unchanged[]`, `needsAdmin[]`, and `failed[]` labels only.

- [ ] **Step 1: Write the failing test**

Use lightweight dependency fakes to prove repair calls experience ensure once, calls review workflow installation for frontend/backend, treats existing workflows as unchanged, converts permission-style review failures to `needsAdmin`, and never performs delete/overwrite operations.

- [ ] **Step 2: Run test to verify it fails**

Confirm missing repair service causes RED.

- [ ] **Step 3: Write minimal implementation**

Reuse `ensureProjectExperience()` for channels/panels and `ensureProjectReviewWorkflows()` for workflows. Do not recreate Google Calendar automatically when an existing `calendarId` is stored; when no calendar exists, only report `설정 필요` unless global OAuth and a dedicated safe creation path are already available.

- [ ] **Step 4: Run test to verify it passes**

Run full test/build/diff-check workflow.

- [ ] **Step 5: Commit**

Commit message: `feat: add safe project auto repair`

---

### Task 4: Add optional Notion/Figma integration settings

**Files:**
- Create: `src/services/project-experience/project-settings.ts`
- Modify: `src/services/project-experience/project-admin.ts`
- Modify: `src/index.ts`
- Create: `tests/project-settings.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `buildProjectSettingsModalId(kind, projectId)` for `notion | figma`
- Produces: `parseProjectSettingsModalId(customId)`
- Produces: validated optional URL parsers that accept empty input to clear only the optional link metadata.

- [ ] **Step 1: Write the failing test**

Assert valid Notion/Figma HTTPS URLs, empty optional values, invalid host rejection, and stable modal IDs.

- [ ] **Step 2: Run test to verify it fails**

Confirm missing settings service causes RED.

- [ ] **Step 3: Write minimal implementation**

Settings panel opens modals with current link values prefilled. Saving updates only project integration metadata; it never accepts or displays PAT/OAuth/Discord secrets.

- [ ] **Step 4: Run test to verify it passes**

Run full test/build/diff-check workflow.

- [ ] **Step 5: Commit**

Commit message: `feat: add optional project integration settings`

---

### Task 5: Refresh health during startup migration

**Files:**
- Modify: `src/services/project-experience/project-migration.ts`
- Modify: `src/services/project-experience/project-hub.ts`
- Modify: `tests/project-migration.test.ts`

**Interfaces:**
- Startup uses centralized `storedProjectHealth()` after each ensure operation.
- Duplicate stored project records sharing a guild/category reuse the same ensured resources but are not deleted.

- [ ] **Step 1: Write the failing test**

Assert migrated projects with existing hub/scrum panel IDs do not duplicate resources, health is refreshed after stored IDs change, and duplicate project records are not removed.

- [ ] **Step 2: Run test to verify it fails**

Confirm current migration does not expose the required health-refresh behavior.

- [ ] **Step 3: Write minimal implementation**

Refresh the hub using the post-repair stored project snapshot and isolate each project failure with concise server logs.

- [ ] **Step 4: Run test to verify it passes**

Run full `npm test`, `npm run build`, and `git diff --check`.

- [ ] **Step 5: Commit**

Commit message: `feat: refresh project health during migration`

---

## Final verification

- [ ] Run the complete test suite with zero failures.
- [ ] Run TypeScript build successfully.
- [ ] Run `git diff --check` successfully.
- [ ] Confirm PR #39 remains open and unmerged.
- [ ] Confirm no secret/token values were added to tracked files or user-facing messages.
- [ ] Confirm existing `/project`, `/github`, `/scrum`, Calendar, and review automation paths remain available.
