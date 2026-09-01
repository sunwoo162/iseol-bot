# Iseol Zero-Friction Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace command-heavy project creation with a modal-driven setup flow that automatically creates the managed project channels, scrum channel, pinned project hub, and a compact integration-health summary.

**Architecture:** Keep existing GitHub/Notion/Figma/Calendar services, but move orchestration and interaction rendering into focused `services/project-experience/*` modules. `/project create` becomes only the entry trigger; the modal handler validates inputs and delegates to setup orchestration. Existing slash commands remain compatible while the new hub becomes the primary everyday UX.

**Tech Stack:** Node.js 22, TypeScript, discord.js v14, Octokit-backed GitHub services, Node test runner, existing JSON persistence in `data/projects.json`.

**Spec:** `docs/superpowers/specs/2026-09-01-iseol-zero-friction-ux-design.md`

## Global Constraints

- `📌・프로젝트` must be the single obvious project home.
- Buttons/selects are primary UX; existing slash commands remain available for compatibility.
- Notion and Figma are optional during project creation.
- Frontend and Backend repositories remain required in Phase 1.
- Missing optional integrations must not roll back the entire project.
- Do not guess repository identities, user identities, or destructive targets.
- Global secrets such as GitHub PAT and Google OAuth credentials remain server-side only.
- Existing repository workflows must never be overwritten.
- All new `StoredProject` fields must be optional so existing JSON requires no incompatible migration.
- Use TDD, small commits, `npm test`, `npm run build`, and `git diff --check` before deployment.

---

## File map

- `src/services/projects.ts` — persisted project metadata and duplicate repository-pair lookup.
- `src/services/project-experience/project-custom-id.ts` — stable parser/builders for hub/admin interaction IDs.
- `src/services/project-experience/project-health.ts` — pure health-state model and rendering copy.
- `src/services/project-experience/project-hub.ts` — project hub message construction and refresh logic.
- `src/services/project-experience/project-setup.ts` — modal input parsing, validation, and partial-success setup orchestration.
- `src/services/project-experience/project-migration.ts` — idempotent startup ensure for hub/scrum on existing projects.
- `src/commands/project.ts` — `/project create` trigger and delete compatibility path.
- `src/index.ts` — thin dispatch for project setup modal and hub button families.
- `tests/project-experience.test.ts` — pure parser/health/custom-id behavior.
- `tests/project-setup.test.ts` — setup validation, optional-link handling, duplicate protection.
- `tests/project-migration.test.ts` — startup idempotency contract.
- `package.json` — include new tests in `npm test`.

---

### Task 1: Persist hub metadata and prevent duplicate repository pairs

**Files:**
- Modify: `src/services/projects.ts`
- Create: `tests/project-setup.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing `RepositoryRef`, `StoredProject`, `listProjects()`.
- Produces: `normalizeRepositoryPair(frontend, backend): string`, `findProjectByRepositories(guildId, frontend, backend): Promise<StoredProject | null>`, optional `hubPanelMessageId`, `scrumChannelId`, `scrumPanelMessageId` fields.

- [ ] **Step 1: Write the failing persistence/duplicate test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRepositoryPair } from "../src/services/projects.js";

const frontend = { owner: "Rain-GJ", repo: "Front", url: "https://github.com/Rain-GJ/Front" };
const backend = { owner: "rain-gj", repo: "Back", url: "https://github.com/rain-gj/Back" };

test("repository pair key is case-insensitive and order-independent", () => {
  assert.equal(
    normalizeRepositoryPair(frontend, backend),
    normalizeRepositoryPair(backend, frontend),
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test tests/project-setup.test.ts
```

Expected: FAIL because `normalizeRepositoryPair` is not exported.

- [ ] **Step 3: Extend `StoredProject` and add repository-pair helpers**

```ts
export type StoredProject = {
  // existing fields...
  hubPanelMessageId?: string;
  scrumChannelId?: string;
  scrumPanelMessageId?: string;
};

export function normalizeRepositoryPair(frontend: RepositoryRef, backend: RepositoryRef): string {
  return [frontend, backend]
    .map((repository) => `${repository.owner}/${repository.repo}`.toLowerCase())
    .sort()
    .join("|");
}

export async function findProjectByRepositories(
  guildId: string,
  frontend: RepositoryRef,
  backend: RepositoryRef,
): Promise<StoredProject | null> {
  const target = normalizeRepositoryPair(frontend, backend);
  const projects = await readProjects();
  return projects.find((project) =>
    project.guildId === guildId
    && normalizeRepositoryPair(project.frontend, project.backend) === target,
  ) ?? null;
}
```

- [ ] **Step 4: Add `tests/project-setup.test.ts` to `npm test` and verify GREEN**

Run:

```bash
npm test
```

Expected: all existing tests plus the new repository-pair test PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/projects.ts tests/project-setup.test.ts package.json
git commit -m "feat: prevent duplicate project repository pairs"
```

---

### Task 2: Add stable hub interaction IDs and pure health rendering

**Files:**
- Create: `src/services/project-experience/project-custom-id.ts`
- Create: `src/services/project-experience/project-health.ts`
- Create: `tests/project-experience.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `buildProjectHubId(action, projectId): string`, `parseProjectHubId(customId): { action; projectId } | null`, `ProjectHealth`, `projectHealthLines(health): string[]`.

- [ ] **Step 1: Write failing parser and health tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectHubId, parseProjectHubId } from "../src/services/project-experience/project-custom-id.js";
import { projectHealthLines } from "../src/services/project-experience/project-health.js";

test("project hub custom ids round-trip", () => {
  const id = buildProjectHubId("calendar", "abc123");
  assert.equal(id, "project_hub:calendar:abc123");
  assert.deepEqual(parseProjectHubId(id), { action: "calendar", projectId: "abc123" });
});

test("project health uses short user-facing states", () => {
  const lines = projectHealthLines({
    github: "connected",
    review: "needs_admin",
    calendar: "needs_setup",
    scrum: "connected",
    notion: "connected",
    figma: "needs_setup",
  });
  assert.ok(lines.some((line) => line.includes("Code Review") && line.includes("관리자 설정 필요")));
  assert.ok(lines.every((line) => !line.includes("403")));
});
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --import tsx --test tests/project-experience.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement interaction ID helpers**

```ts
export type ProjectHubAction = "calendar" | "scrum" | "github" | "review" | "refresh" | "admin";

export function buildProjectHubId(action: ProjectHubAction, projectId: string): string {
  return `project_hub:${action}:${projectId}`;
}

export function parseProjectHubId(customId: string): { action: ProjectHubAction; projectId: string } | null {
  const match = /^project_hub:(calendar|scrum|github|review|refresh|admin):([A-Za-z0-9_-]+)$/.exec(customId);
  return match ? { action: match[1] as ProjectHubAction, projectId: match[2]! } : null;
}
```

- [ ] **Step 4: Implement pure health copy**

```ts
export type ProjectHealthState = "connected" | "needs_setup" | "needs_admin" | "checking" | "repair";

export type ProjectHealth = {
  github: ProjectHealthState;
  review: ProjectHealthState;
  calendar: ProjectHealthState;
  scrum: ProjectHealthState;
  notion: ProjectHealthState;
  figma: ProjectHealthState;
};

const stateCopy: Record<ProjectHealthState, string> = {
  connected: "✅ 연결됨",
  needs_setup: "⚠️ 설정 필요",
  needs_admin: "⚠️ 관리자 설정 필요",
  checking: "⏳ 확인 중",
  repair: "❌ 복구 필요",
};

export function projectHealthLines(health: ProjectHealth): string[] {
  return [
    `🐙 GitHub · ${stateCopy[health.github]}`,
    `🔍 Code Review · ${stateCopy[health.review]}`,
    `📅 Google Calendar · ${stateCopy[health.calendar]}`,
    `📋 Scrum · ${stateCopy[health.scrum]}`,
    `📄 Notion · ${stateCopy[health.notion]}`,
    `🎨 Figma · ${stateCopy[health.figma]}`,
  ];
}
```

- [ ] **Step 5: Add test file to `npm test` and verify GREEN**

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/project-experience/project-custom-id.ts src/services/project-experience/project-health.ts tests/project-experience.test.ts package.json
git commit -m "feat: add project hub interaction model"
```

---

### Task 3: Build project setup parser with optional Notion/Figma and duplicate protection

**Files:**
- Create: `src/services/project-experience/project-setup.ts`
- Modify: `tests/project-setup.test.ts`

**Interfaces:**
- Consumes: `parseGitHubRepository`, `parseNotionPage`, `parseFigmaFile`, `findProjectByRepositories`.
- Produces: `ProjectSetupInput`, `parseProjectSetupFields(fields): ProjectSetupInput`, `assertProjectSetupNotDuplicate(guildId, input): Promise<void>`.

- [ ] **Step 1: Add failing optional-input tests**

```ts
import { parseProjectSetupFields } from "../src/services/project-experience/project-setup.js";

test("project setup accepts empty notion and figma", () => {
  const parsed = parseProjectSetupFields({
    name: "Rain GJ",
    frontend: "https://github.com/rain-gj/rain-gj-frontend",
    backend: "https://github.com/rain-gj/rain-gj-backend",
    notion: "",
    figma: "",
  });
  assert.equal(parsed.name, "Rain GJ");
  assert.equal(parsed.notion, null);
  assert.equal(parsed.figma, null);
});
```

- [ ] **Step 2: Run focused test and verify RED**

```bash
node --import tsx --test tests/project-setup.test.ts
```

Expected: module-not-found failure for `project-setup`.

- [ ] **Step 3: Implement parsing without Discord dependencies**

```ts
export type RawProjectSetupFields = {
  name: string;
  frontend: string;
  backend: string;
  notion: string;
  figma: string;
};

export type ProjectSetupInput = {
  name: string;
  frontend: RepositoryRef;
  backend: RepositoryRef;
  notion: ReturnType<typeof parseNotionPage> | null;
  figma: ReturnType<typeof parseFigmaFile> | null;
};

export function parseProjectSetupFields(fields: RawProjectSetupFields): ProjectSetupInput {
  const name = fields.name.trim();
  if (name.length < 2 || name.length > 50) throw new Error("프로젝트 이름은 2~50자로 입력해주세요.");

  const frontend = parseGitHubRepository(fields.frontend.trim());
  const backend = parseGitHubRepository(fields.backend.trim());
  if (frontend.owner.toLowerCase() !== backend.owner.toLowerCase()) {
    throw new Error("Frontend와 Backend 저장소는 같은 GitHub Organization 아래에 있어야 합니다.");
  }

  return {
    name,
    frontend,
    backend,
    notion: fields.notion.trim() ? parseNotionPage(fields.notion.trim()) : null,
    figma: fields.figma.trim() ? parseFigmaFile(fields.figma.trim()) : null,
  };
}
```

- [ ] **Step 4: Add duplicate assertion**

```ts
export async function assertProjectSetupNotDuplicate(guildId: string, input: ProjectSetupInput): Promise<void> {
  const duplicate = await findProjectByRepositories(guildId, input.frontend, input.backend);
  if (duplicate) {
    throw new Error(`이미 **${duplicate.name}** 프로젝트에 같은 GitHub 저장소가 연결되어 있습니다.`);
  }
}
```

- [ ] **Step 5: Run setup tests and full suite**

```bash
node --import tsx --test tests/project-setup.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/project-experience/project-setup.ts tests/project-setup.test.ts
git commit -m "feat: add modal project setup parser"
```

---

### Task 4: Render and pin the project hub

**Files:**
- Create: `src/services/project-experience/project-hub.ts`
- Modify: `tests/project-experience.test.ts`

**Interfaces:**
- Consumes: `StoredProject`, `ProjectHealth`, `buildProjectHubId`.
- Produces: `projectHubMessage(project, health)`, `ensureProjectHub(channel, project, health): Promise<string>`.

- [ ] **Step 1: Write failing hub-render test**

```ts
import { projectHubMessage } from "../src/services/project-experience/project-hub.js";

test("project hub exposes the five primary member actions", () => {
  const payload = projectHubMessage(projectFixture, connectedHealthFixture);
  const ids = payload.components.flatMap((row) => row.components.map((component) => component.data.custom_id));
  assert.ok(ids.includes(`project_hub:calendar:${projectFixture.id}`));
  assert.ok(ids.includes(`project_hub:scrum:${projectFixture.id}`));
  assert.ok(ids.includes(`project_hub:github:${projectFixture.id}`));
  assert.ok(ids.includes(`project_hub:review:${projectFixture.id}`));
  assert.ok(ids.includes(`project_hub:refresh:${projectFixture.id}`));
});
```

- [ ] **Step 2: Run focused test and verify RED**

```bash
node --import tsx --test tests/project-experience.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the pure hub payload**

```ts
export function projectHubMessage(project: StoredProject, health: ProjectHealth) {
  const memberRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(buildProjectHubId("calendar", project.id)).setLabel("일정").setEmoji("📅").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(buildProjectHubId("scrum", project.id)).setLabel("스크럼").setEmoji("📋").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(buildProjectHubId("github", project.id)).setLabel("GitHub").setEmoji("🐙").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(buildProjectHubId("review", project.id)).setLabel("리뷰 상태").setEmoji("🔍").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(buildProjectHubId("refresh", project.id)).setLabel("새로고침").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
  );

  const embed = new EmbedBuilder()
    .setTitle(`📌 ${project.name}`)
    .setDescription("이 프로젝트의 일정, 스크럼, GitHub, 코드리뷰 상태를 여기서 관리합니다.")
    .addFields({ name: "연동 상태", value: projectHealthLines(health).join("\n") });

  return { embeds: [embed], components: [memberRow] };
}
```

- [ ] **Step 4: Implement `ensureProjectHub` as idempotent message create/edit**

Behavior:

```ts
export async function ensureProjectHub(
  channel: TextChannel,
  project: StoredProject,
  health: ProjectHealth,
): Promise<string> {
  if (project.hubPanelMessageId) {
    const existing = await channel.messages.fetch(project.hubPanelMessageId).catch(() => null);
    if (existing) {
      await existing.edit(projectHubMessage(project, health));
      if (!existing.pinned) await existing.pin();
      return existing.id;
    }
  }

  const created = await channel.send(projectHubMessage(project, health));
  await created.pin();
  return created.id;
}
```

- [ ] **Step 5: Run tests**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/project-experience/project-hub.ts tests/project-experience.test.ts
git commit -m "feat: add pinned project hub"
```

---

### Task 5: Replace `/project create` options with a setup modal and automatic scrum/hub creation

**Files:**
- Modify: `src/commands/project.ts`
- Modify: `src/index.ts`
- Modify: `src/services/project-experience/project-setup.ts`
- Modify: `tests/project-setup.test.ts`

**Interfaces:**
- Produces: `showProjectSetupModal(interaction)`, `handleProjectSetupModal(interaction): Promise<boolean>`, `createProjectExperience(...)` partial-success result.

- [ ] **Step 1: Change command definition test/contract**

Add a test that serializes `projectCommand.toJSON()` and asserts the `create` subcommand has no string options.

```ts
test("project create opens a modal instead of exposing five command options", () => {
  const json = projectCommand.toJSON();
  const create = json.options?.find((option) => option.name === "create");
  assert.deepEqual(create?.options ?? [], []);
});
```

- [ ] **Step 2: Run focused test and verify RED**

```bash
node --import tsx --test tests/project-setup.test.ts
```

Expected: FAIL because the current command still contains five options.

- [ ] **Step 3: Make `/project create` open one modal**

Modal fields:

```ts
const modal = new ModalBuilder()
  .setCustomId("project_setup_modal")
  .setTitle("이설 프로젝트 만들기")
  .addComponents(
    modalText("name", "프로젝트 이름", "예: Rain GJ", true),
    modalText("frontend", "Frontend GitHub", "https://github.com/org/frontend", true),
    modalText("backend", "Backend GitHub", "https://github.com/org/backend", true),
    modalText("notion", "Notion (선택)", "https://www.notion.so/...", false),
    modalText("figma", "Figma (선택)", "https://www.figma.com/design/...", false),
  );
```

`handleProjectCommand()` should call `showProjectSetupModal()` for `create` and retain the current delete path.

- [ ] **Step 4: Implement partial-success orchestration**

Create the managed channels in this exact set:

```ts
const managedChannels = [
  "📌・프로젝트",
  "📄・기능명세서",
  "🎨・figma",
  "💬・토론",
  "🗓・데일리스크럼",
  "💻・frontend-log",
  "🛠・backend-log",
  "📅・일정",
] as const;
```

Rules:
- Repository validation and duplicate detection happen before creating the category.
- GitHub owner must resolve to an Organization.
- Notion/Figma validation happens only when a URL was supplied.
- Calendar creation is attempted only when global OAuth is configured.
- Optional Notion/Figma/Calendar/workflow failures append a human-readable warning and do not roll back Discord resources.
- Core Discord category/channel creation failure still triggers cleanup of resources created in that attempt.
- Persist `scrumChannelId` and `hubPanelMessageId`.

Return:

```ts
export type ProjectSetupResult = {
  project: StoredProject;
  warnings: Array<"notion" | "figma" | "calendar" | "review_workflow">;
};
```

- [ ] **Step 5: Route the setup modal in `index.ts`**

Before other project modal handlers:

```ts
if (interaction.isModalSubmit() && interaction.customId === "project_setup_modal") {
  await handleProjectSetupModal(interaction);
  await ensureProjectDiscussionChannels(client);
  return;
}
```

- [ ] **Step 6: Verify full suite and build**

```bash
npm test
npm run build
git diff --check
```

Expected: all PASS / clean.

- [ ] **Step 7: Commit**

```bash
git add src/commands/project.ts src/index.ts src/services/project-experience/project-setup.ts tests/project-setup.test.ts
git commit -m "feat: automate project setup from one modal"
```

---

### Task 6: Add startup migration/ensure for existing projects

**Files:**
- Create: `src/services/project-experience/project-migration.ts`
- Create: `tests/project-migration.test.ts`
- Modify: `src/index.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `ensureProjectExperience(client, project): Promise<{ hubPanelMessageId?: string; scrumChannelId?: string }>`, `ensureAllProjectExperiences(client): Promise<void>`.

- [ ] **Step 1: Write failing idempotency test around the pure ensure decision**

Extract a pure helper:

```ts
export function projectExperienceNeeds(project: StoredProject): { hub: boolean; scrum: boolean } {
  return {
    hub: !project.hubPanelMessageId,
    scrum: !project.scrumChannelId,
  };
}
```

Test:

```ts
test("legacy project without hub and scrum is marked for both ensures", () => {
  assert.deepEqual(projectExperienceNeeds(legacyProjectFixture), { hub: true, scrum: true });
});

test("fully migrated project needs no duplicate resources", () => {
  assert.deepEqual(projectExperienceNeeds({
    ...legacyProjectFixture,
    hubPanelMessageId: "hub1",
    scrumChannelId: "scrum1",
  }), { hub: false, scrum: false });
});
```

- [ ] **Step 2: Run focused test and verify RED**

```bash
node --import tsx --test tests/project-migration.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement startup ensure**

For each stored project:
- fetch guild/category,
- find existing `📌・프로젝트` and `🗓・데일리스크럼` children by exact name before creating anything,
- create missing scrum channel only when absent,
- render/ensure one hub message in the existing project channel,
- update stored IDs,
- catch/log errors per project and continue.

Do not:
- delete duplicate project records,
- delete user channels,
- recreate Notion/Figma/Calendar in Phase 1 migration,
- overwrite existing review workflows.

- [ ] **Step 4: Start migration on `ClientReady`**

Add after existing discussion-channel ensure:

```ts
await ensureAllProjectExperiences(client);
```

Migration failure must be caught internally per project so it never prevents the bot from reaching ready state.

- [ ] **Step 5: Run all verification**

```bash
npm test
npm run build
git diff --check
```

Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/project-experience/project-migration.ts tests/project-migration.test.ts src/index.ts package.json
git commit -m "feat: migrate existing projects to hub experience"
```

---

### Task 7: Wire Phase 1 hub actions with safe placeholder panels, not dead buttons

**Files:**
- Modify: `src/services/project-experience/project-hub.ts`
- Modify: `src/index.ts`
- Modify: `tests/project-experience.test.ts`

**Interfaces:**
- Produces: `handleProjectHubButton(interaction): Promise<boolean>`.

- [ ] **Step 1: Write failing routing tests for each action**

Use pure `parseProjectHubId` plus a response-model helper:

```ts
export function projectHubActionCopy(action: ProjectHubAction): string {
  if (action === "calendar") return "📅 일정 관리";
  if (action === "scrum") return "📋 데일리 스크럼";
  if (action === "github") return "🐙 GitHub 계정/프로젝트";
  if (action === "review") return "🔍 코드리뷰 상태";
  if (action === "refresh") return "🔄 프로젝트 상태 새로고침";
  return "⚙️ 프로젝트 관리";
}
```

Assert every rendered button maps to non-empty copy and a recognized action.

- [ ] **Step 2: Run focused test and verify RED**

```bash
node --import tsx --test tests/project-experience.test.ts
```

Expected: FAIL until handler/copy exists.

- [ ] **Step 3: Implement Phase 1 button behavior**

- `calendar`: respond with the existing `calendarPanel(project.id, project.calendarUrl)` ephemerally.
- `scrum`: respond ephemerally with channel mention and instruction that button-driven write arrives in Phase 3; if `scrumChannelId` exists, include `<#id>`.
- `github`: show linked repository URLs and existing `GitHub Organization 참여` path; do not reimplement account linking yet.
- `review`: show frontend/backend review setup state using available stored/config data; token failures become `관리자 설정 필요` copy.
- `refresh`: recompute the hub payload and edit the pinned hub message, then acknowledge ephemerally.
- `admin`: reject non-`ManageChannels`; for admins show a Phase 1 admin summary without destructive actions yet.

This task exists so the new hub never ships with buttons that silently do nothing. Later phases replace the temporary scrum/GitHub/admin subpanels with richer controls.

- [ ] **Step 4: Route hub buttons before legacy button handlers**

```ts
if (interaction.isButton() && interaction.customId.startsWith("project_hub:")) {
  if (await handleProjectHubButton(interaction)) return;
}
```

- [ ] **Step 5: Final Phase 1 verification**

```bash
npm test
npm run build
git diff --check
git status --short --branch
```

Expected: tests PASS, build exit 0, diff-check clean, only intended branch commits present.

- [ ] **Step 6: Commit**

```bash
git add src/services/project-experience/project-hub.ts src/index.ts tests/project-experience.test.ts
git commit -m "feat: route project hub actions"
```

---

## Phase 1 completion gate

Before deployment, verify all of the following from a fresh checkout of `feat/calendar-code-review`:

```bash
npm ci
npm test
npm run build
git diff --check
```

Then inspect the diff and confirm:

- `/project create` opens one modal.
- Notion/Figma are optional.
- duplicate repository pairs are rejected before Discord resources are created.
- new projects automatically receive `🗓・데일리스크럼`.
- `📌・프로젝트` has exactly one pinned hub message.
- existing projects are ensured idempotently on startup.
- no raw API/PAT error appears in the hub.
- no existing review workflow is overwritten.
- existing `/project delete`, `/github`, `/scrum`, Calendar, code-review polling behavior remains intact.
