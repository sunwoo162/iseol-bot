# Iseol Discord Contextualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect existing Discord project operations to the same durable Project Workspace `projectId / nodeId / runId` state used by Iseol Web without breaking legacy bot behavior.

**Architecture:** Preserve `StoredProject` as the Discord/provider runtime record. Add an explicit binding store that maps a guild-scoped StoredProject to a promoted Project Workspace, then resolve a combined Discord project context through existing Project Model validation. Existing provider actions remain authoritative; bound actions append idempotent Project History after provider success.

**Tech Stack:** TypeScript 7, Node.js 22, discord.js 14, existing JSON/JSONL Project Model stores, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-07-iseol-discord-contextualization-design.md`

## Global Constraints

- Read `docs/HARNESS_ENGINEERING.md` before every implementation task.
- Preserve `/project create`, `/project delete`, Calendar, GitHub review, Figma, Notion, and existing notification behavior.
- Never auto-bind by project name or repository URL.
- Every resolver path checks Discord `guildId` before exposing project data.
- Binding exists only as coordination metadata; Project Workspace remains the durable product/development truth.
- Stale bindings fail closed for Workspace mutation/history and must not silently downgrade to legacy-only context.
- Provider success and Project History recording are separate; history failure must never cause provider mutation replay.
- No raw provider payload, OAuth secret, token, credential, or Harness policy content enters Project History/status cards.
- All commits use English Conventional Commit-style messages.

---

## File structure

- `src/services/project-context.ts` — read-only `StoredProject -> ProjectContext` mapping with guild isolation.
- `src/discord-project/contracts.ts` — binding and aggregate Discord context contracts.
- `src/discord-project/binding-store.ts` — atomic explicit binding lifecycle.
- `src/discord-project/context-resolver.ts` — legacy + binding + ProjectWorkContext validation.
- `src/discord-project/status-card.ts` — pure Discord status view model/embed data builder.
- `src/discord-project/history-recorder.ts` — deterministic idempotent Project History append.
- `src/discord-project/action-context.ts` — reusable helper for project-scoped Discord/provider events.
- Existing provider/interaction files are modified only at narrow integration seams.
### Task 1: Legacy ProjectContext and explicit binding store

**Files:**
- Create: `src/services/project-context.ts`
- Create: `src/discord-project/contracts.ts`
- Create: `src/discord-project/binding-store.ts`
- Create: `tests/discord-project-binding.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `ProjectContext`, `mapStoredProjectContext(project)`, `resolveProjectContext(projectId, guildId, find?)`.
- Produces: `DiscordProjectBinding`, `loadDiscordProjectBinding(root, guildId, storedProjectId)`, `createDiscordProjectBinding(...)`, `deleteDiscordProjectBinding(...)`.

- [ ] Write failing tests proving every required/optional StoredProject field maps correctly, guild mismatch returns `null`, missing project returns `null`, and repository side selection accepts only `frontend | backend`.
- [ ] Write failing binding tests for atomic create/read/delete, safe IDs, one active binding per `(guildId, storedProjectId)`, same-target idempotency, and different-target rebind rejection.
- [ ] Run `node --import tsx --test tests/discord-project-binding.test.ts` and confirm RED due missing modules/exports.
- [ ] Implement the read model without persisting a second project copy; inject `findProject` for deterministic tests.
- [ ] Implement binding files under caller-supplied root using safe ID validation plus temp-file/rename writes. Existing different target throws an explicit rebind-required error.
- [ ] Run focused tests and `npm run build` and confirm PASS.
- [ ] Add the focused test to `npm test` and commit `feat: add discord project bindings`.

### Task 2: Aggregate Discord project context resolver

**Files:**
- Create: `src/discord-project/context-resolver.ts`
- Create: `tests/discord-project-context.test.ts`

**Interfaces:**
- Consumes: Task 1 `ProjectContext` and binding store; existing `resolveProjectWorkContext()`.
- Produces: `resolveDiscordProjectContext(input)` returning `{ legacy, binding?, work?, state: "legacy-only" | "bound" | "stale-binding" }`.

- [ ] Write failing tests for unbound legacy projects, valid root binding, explicit node binding, valid attached Run, invalid Run/node relation, guild mismatch, missing workspace, and stale default node.
- [ ] Assert a stale binding returns an explicit `stale-binding` result and never returns a writable `work` context.
- [ ] Run the focused test and confirm RED.
- [ ] Implement resolution in the exact order: legacy guild check → binding read → workspace existence → default/requested node → optional Run validation.
- [ ] Do not infer a Run or feature node when callers omit them.
- [ ] Run focused tests plus build and confirm PASS.
- [ ] Register test and commit `feat: resolve discord project work context`.
### Task 3: `/project bind` and `/project status`

**Files:**
- Create: `src/discord-project/status-card.ts`
- Modify: `src/commands/project.ts`
- Create: `tests/discord-project-status.test.ts`
- Modify: `tests/interaction-router.test.ts` only if routing contracts change.

**Interfaces:**
- Consumes: Task 2 aggregate resolver; `listProjects()`, `listProjectWorkspaces()`, `loadHarnessRun()`.
- Produces: pure `buildDiscordProjectStatus(context, deps)` data plus project command handlers for `bind` and `status`.

- [ ] Write failing pure status tests for legacy-only, bound active, archived workspace, stale binding, attached Run summaries, integration flags, and Genesis deployment link.
- [ ] Write command-level tests with fake interactions proving bind/status are guild-isolated, bind requires an active workspace/root node, repeated same bind is idempotent, and a conflicting bind is rejected without overwrite.
- [ ] Add autocomplete coverage for StoredProject and Project Workspace choices scoped to the current guild/project state.
- [ ] Run focused tests and confirm RED.
- [ ] Extend `projectCommand` with `bind` and `status` while preserving `create/delete` signatures and behavior.
- [ ] Render status through the pure builder so no token/credential/provider payload reaches Discord output.
- [ ] On project delete, remove only that Discord binding after the existing delete flow succeeds; never delete the Project Workspace.
- [ ] Run focused tests plus build and confirm PASS.
- [ ] Register tests and commit `feat: add discord project workspace status`.

### Task 4: Idempotent contextual Project History recorder

**Files:**
- Modify: `src/project-model/contracts.ts`
- Modify: `src/project-model/history-store.ts`
- Create: `src/discord-project/history-recorder.ts`
- Create: `src/discord-project/action-context.ts`
- Create: `tests/discord-project-history.test.ts`

**Interfaces:**
- Adds history types: `discord-project-bound`, `discord-action-recorded`, `integration-action-recorded`, `review-recorded`.
- Produces: `recordDiscordProjectHistory(input)` and deterministic `discordProjectHistoryEventId(input)`.
- Produces: `resolveBoundActionContext(...)` that returns writable context only for valid bound Workspace state.

- [ ] Write failing tests for metadata shape (`source`, `action`, `reference`, `nodeId`, `runId`), secret-free summaries, deterministic IDs, duplicate suppression, and stale-binding rejection.
- [ ] Write a retry test: simulated history append failure after a provider success receipt, then recorder retry appends exactly one event without calling the provider fake again.
- [ ] Run focused tests and confirm RED.
- [ ] Extend Project History contracts additively; do not alter existing event semantics.
- [ ] Add an idempotent append helper that checks event identity before append and treats an existing identical event as success.
- [ ] Implement the contextual recorder so it accepts only already-completed action facts; it must never call provider mutation APIs itself.
- [ ] Run focused tests plus build and confirm PASS.
- [ ] Register test and commit `feat: record contextual discord project history`.
### Task 5: Contextualize existing provider/project events

**Files:**
- Modify: `src/services/calendar/calendar-discord.ts`
- Modify: `src/services/github-automation-polling.ts`
- Modify: `src/services/webhook-server.ts` (Figma named-version/comment and Notion update polling notification seams)
- Create: `tests/discord-project-provider-context.test.ts`
- Modify: existing Calendar/review/Figma/Notion tests only where dependency injection is needed.

**Interfaces:**
- Consumes: Task 4 `resolveBoundActionContext()` and `recordDiscordProjectHistory()`.
- Existing provider functions remain authoritative and are invoked before contextual history recording.

- [ ] Write failing tests proving unbound Calendar actions preserve existing behavior and append no Project History.
- [ ] Write bound Calendar/GitHub Issue tests proving one successful provider action appends exactly one contextual event at the default/explicit node.
- [ ] Add GitHub review polling tests proving completed review results append one `review-recorded` event and repeated poll processing does not duplicate it.
- [ ] Add tests around `pollProjectVersions`, `pollProjectComments`, and `pollProjectNotion` behavior in `src/services/webhook-server.ts` proving successful bound notifications append one integration history event while unbound projects remain unchanged.
- [ ] Add a provider-success/history-failure test proving a retry path records history only and never repeats the provider mutation.
- [ ] Run focused tests and confirm RED before each integration seam is implemented.
- [ ] Add narrow recording calls after successful existing provider behavior; do not restructure provider service implementations.
- [ ] Run all focused contextualization tests plus build and confirm PASS.
- [ ] Commit `feat: contextualize discord project integrations`.

### Task 6: Shared-state regression and phase verification

**Files:**
- Create: `tests/discord-web-shared-state.test.ts`
- Modify: `docs/superpowers/plans/2026-09-07-iseol-discord-contextualization.md`

**Interfaces:**
- Proves Discord resolver/status and Iseol Web view models read the same Project Workspace/Harness Run state.

- [ ] Write a shared-state test that creates one Project Workspace + Run, binds a StoredProject, changes tree/Run state once, then verifies Discord status and Web view observe the same node/status/run stage without synchronization code.
- [ ] Verify an unbound legacy project remains fully usable through its existing project/integration paths.
- [ ] Re-read `docs/HARNESS_ENGINEERING.md`.
- [ ] Run every `tests/discord-project-*.test.ts` and `tests/discord-web-shared-state.test.ts` focused test.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Confirm existing `/project create/delete`, Calendar, GitHub review, Figma, Notion, and provider tests remain green.
- [ ] Confirm `data/projects.json` format is unchanged and no fuzzy binding logic exists.
- [ ] Record exact verification counts, protected-file review, and integration notes in this plan.

## Phase completion gate

This phase is complete only when existing Discord project functions still work unbound, explicit binding safely exposes the same Workspace/tree/Run state as Web, contextual provider results produce idempotent durable Project History, stale identities fail closed, and the full existing test/build suite remains green.
