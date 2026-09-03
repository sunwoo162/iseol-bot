# Iseol Scrum and GitHub Account Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make daily scrum and project GitHub membership fully button-driven from pinned Discord panels while asking for a GitHub username at most once per guild.

**Architecture:** Keep `daily-scrum.ts` and `github-user.ts` as the persistence/service sources of truth. Add focused Discord interaction modules for scrum and GitHub account UX, then make `project-hub.ts` delegate to them and let startup migration ensure the pinned scrum panel idempotently. Legacy slash commands remain operational.

**Tech Stack:** TypeScript, Node.js 22, discord.js 14, existing JSON persistence services, GitHub REST service wrappers, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-01-iseol-zero-friction-ux-design.md`

## Global Constraints

- Keep `feat/calendar-code-review`; do not merge PR #39.
- Keep existing `/scrum` and `/github` slash commands working.
- GitHub identity is stored at guild + Discord user level and reused across projects in that guild.
- Never ask for a GitHub username again when a valid stored link exists.
- Organization join must never guess an identity; require a stored, validated GitHub link.
- Scrum panels and startup repair must be idempotent and must not duplicate managed messages.
- Destructive or disconnect actions require an explicit user action.
- User-facing errors remain short; detailed API errors stay in server logs.
- Before each task is accepted, run tests; before Phase 3 completion run full `npm test`, `npm run build`, and `git diff --check`.

---

### Task 1: Scrum panel contract and startup pinning

**Files:**
- Create: `src/services/daily-scrum-discord.ts`
- Modify: `src/services/project-experience/project-migration.ts`
- Test: `tests/daily-scrum-discord.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `buildProjectScrumId(action, projectId)`, `parseProjectScrumId(customId)`, `scrumPanelMessage(project)`, `ensureScrumPanel(channel, project)`.
- Consumes: `StoredProject.scrumPanelMessageId`, `updateProject`, existing `🗓・데일리스크럼` channel.

- [ ] **Step 1: Write the failing tests**

```ts
test("project scrum custom ids round-trip", () => {
  assert.deepEqual(parseProjectScrumId(buildProjectScrumId("write", "p1")), {
    action: "write",
    projectId: "p1",
  });
});

test("scrum panel exposes the three member actions", () => {
  const payload = scrumPanelMessage(projectFixture);
  const ids = payload.components.flatMap((row) => row.components.map((item) => item.data.custom_id));
  assert.deepEqual(ids, [
    "project_scrum:write:p1",
    "project_scrum:carry:p1",
    "project_scrum:recent:p1",
  ]);
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test`
Expected: FAIL because `daily-scrum-discord.ts` and exported contracts do not exist.

- [ ] **Step 3: Implement minimal pinned panel service**

```ts
export type ProjectScrumAction = "write" | "carry" | "recent";

export function buildProjectScrumId(action: ProjectScrumAction, projectId: string): string {
  return `project_scrum:${action}:${projectId}`;
}

export function parseProjectScrumId(customId: string) {
  const match = /^project_scrum:(write|carry|recent):([A-Za-z0-9_-]+)$/.exec(customId);
  return match ? { action: match[1] as ProjectScrumAction, projectId: match[2]! } : null;
}
```

Render one pinned message with `✍️ 오늘 작성/수정`, `✅ 전날 TODO 완료 처리`, `📖 내 최근 기록`. `ensureScrumPanel` edits/pins `scrumPanelMessageId` when valid and creates exactly one replacement when missing.

Update startup project migration to call `ensureScrumPanel` after ensuring the scrum channel and persist the returned `scrumPanelMessageId`.

- [ ] **Step 4: Run tests and confirm GREEN**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/daily-scrum-discord.ts src/services/project-experience/project-migration.ts tests/daily-scrum-discord.test.ts package.json
git commit -m "feat: add pinned scrum panel"
```

### Task 2: Button-driven scrum write/edit and previous-TODO carry

**Files:**
- Modify: `src/services/daily-scrum-discord.ts`
- Modify: `src/services/daily-scrum.ts`
- Modify: `src/index.ts`
- Test: `tests/daily-scrum-discord.test.ts`

**Interfaces:**
- Produces: `scrumWriteDefaults(todayRecord, yesterdayRecord, carryYesterday)`, `handleProjectScrumButton(interaction)`, `handleProjectScrumModal(interaction)`.
- Consumes: `getDailyScrumRecord`, `saveDailyScrumRecord`, `previousSeoulDateKey`, `seoulDateKey`, Discord project scrum channel.

- [ ] **Step 1: Write failing prefill/carry tests**

```ts
test("scrum write pre-fills today's existing values", () => {
  assert.deepEqual(scrumWriteDefaults(todayRecord, yesterdayRecord, false), {
    todo: todayRecord.todo,
    did: todayRecord.did,
  });
});

test("carry flow prepares yesterday TODO as DID but keeps today's TODO", () => {
  assert.deepEqual(scrumWriteDefaults(todayRecord, yesterdayRecord, true), {
    todo: todayRecord.todo,
    did: yesterdayRecord.todo,
  });
});
```

Add a test that `recent` formatting returns only the current user's latest records and does not expose another user's data.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test`
Expected: FAIL on missing prefill/handler exports.

- [ ] **Step 3: Implement modal and persistence flow**

`write` loads today's record and pre-fills `todo`/`did`. `carry` loads yesterday and today's records, pre-fills yesterday TODO as DID, then still requires modal submission. Modal custom IDs use `project_scrum_write:<projectId>` and `project_scrum_carry:<projectId>`.

On submit:
1. resolve the exact project and guild,
2. validate TODO is non-empty,
3. edit today's existing Discord scrum message when it still exists,
4. otherwise send one new embed,
5. save/update the existing daily scrum record,
6. reply `오늘 스크럼을 기록했습니다` or `오늘 스크럼을 수정했습니다`.

`recent` replies ephemerally with the current user's latest records only.

Route `project_scrum:` buttons and `project_scrum_` modals in `index.ts`.

- [ ] **Step 4: Run tests and confirm GREEN**

Run: `npm test && npm run build && git diff --check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/daily-scrum-discord.ts src/services/daily-scrum.ts src/index.ts tests/daily-scrum-discord.test.ts
git commit -m "feat: add button driven scrum flow"
```

### Task 3: GitHub account panel with one-time identity input

**Files:**
- Create: `src/services/github-account-discord.ts`
- Modify: `src/services/project-experience/project-hub.ts`
- Modify: `src/index.ts`
- Test: `tests/github-account-discord.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `buildProjectGitHubId(action, projectId)`, `parseProjectGitHubId(customId)`, `githubAccountPanel(project, account)`, `handleProjectGitHubButton(interaction)`, `handleProjectGitHubModal(interaction)`.
- Consumes: `findGitHubAccount`, `linkGitHubAccount`, `unlinkGitHubAccount`, `listGitHubAccounts`, `GitHubUserService.getProfile`, `GitHubWebhookService.inviteOrganizationMember`.

- [ ] **Step 1: Write failing panel tests**

```ts
test("unlinked github panel exposes only connect and repository links", () => {
  const payload = githubAccountPanel(projectFixture, null);
  assert.ok(findCustomId(payload, "project_github:connect:p1"));
  assert.ok(!findCustomId(payload, "project_github:join:p1"));
});

test("linked github panel reuses stored username for join", () => {
  const payload = githubAccountPanel(projectFixture, linkedAccount);
  assert.match(payload.content, /@sunwoo162/);
  assert.ok(findCustomId(payload, "project_github:join:p1"));
  assert.ok(findCustomId(payload, "project_github:profile:p1"));
  assert.ok(findCustomId(payload, "project_github:disconnect:p1"));
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test`
Expected: FAIL because `github-account-discord.ts` does not exist.

- [ ] **Step 3: Implement account panel and connect modal**

Use interaction namespace:
- `project_github:connect:<projectId>`
- `project_github:profile:<projectId>`
- `project_github:join:<projectId>`
- `project_github:disconnect:<projectId>`
- modal: `project_github_connect_modal:<projectId>`

Connect modal asks for username once. On submit:
1. normalize and validate username,
2. call `GitHubUserService.getProfile` so the stored login is canonical,
3. reject a GitHub login already linked to another Discord user in the same guild,
4. save `guildId + Discord userId + GitHub login`.

Linked panel displays the stored login. `join` reads the stored account and calls `inviteOrganizationMember(project.organization, account.githubLogin)` without any username modal. `disconnect` explicitly unlinks. `profile` fetches and renders the linked GitHub profile without asking for a username.

- [ ] **Step 4: Delegate hub GitHub action and route interactions**

Replace the current `project_join:`-centric hub panel path with `githubAccountPanel`. Keep legacy `project_join:` buttons functional: if a stored account exists, reuse it for the invite; otherwise guide the user into the one-time connect flow instead of asking for a fresh username.

Route `project_github:` buttons and `project_github_connect_modal:` submissions in `index.ts`.

- [ ] **Step 5: Run tests and confirm GREEN**

Run: `npm test && npm run build && git diff --check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/github-account-discord.ts src/services/project-experience/project-hub.ts src/index.ts tests/github-account-discord.test.ts package.json
git commit -m "feat: add reusable github account panel"
```

### Task 4: Phase 3 migration and compatibility verification

**Files:**
- Modify: `src/services/project-experience/project-migration.ts`
- Modify: `tests/project-migration.test.ts`
- Modify: `tests/project-experience.test.ts`
- Verify: existing `src/commands/scrum.ts`, `src/commands/github.ts`

**Interfaces:**
- Consumes all Phase 3 services.
- Produces a startup experience where existing project categories gain at most one scrum panel and existing command paths remain registered and buildable.

- [ ] **Step 1: Add failing migration/idempotency coverage**

```ts
test("existing project experience requests a scrum panel when metadata is missing", () => {
  assert.deepEqual(projectExperienceNeeds({ ...projectFixture, scrumChannelId: "c1" }), {
    hub: true,
    scrum: false,
    scrumPanel: true,
  });
});
```

Add source-contract assertions that `/scrum write` and `/github connect|profile|disconnect` still exist.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test`
Expected: FAIL until migration need metadata includes the scrum panel.

- [ ] **Step 3: Complete idempotent migration**

Make `projectExperienceNeeds` include `scrumPanel: !project.scrumPanelMessageId`. Ensure migration reuses an existing `scrumPanelMessageId`, creates a replacement only if the stored message is gone, and persists the new message ID. Do not delete duplicate project data or user messages.

- [ ] **Step 4: Run Phase 3 completion gate**

Run:
```bash
npm test
npm run build
git diff --check
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/project-experience/project-migration.ts tests/project-migration.test.ts tests/project-experience.test.ts
git commit -m "test: verify zero friction scrum github migration"
```
