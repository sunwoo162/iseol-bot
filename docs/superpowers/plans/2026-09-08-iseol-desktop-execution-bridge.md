# Iseol Desktop Execution Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the durable Iseol Run Supervisor to a persistent outbound Desktop Agent that safely executes structured repository, process, Git, and file operations with heartbeat, leases, evidence, and reconnect recovery.

**Architecture:** Keep `HarnessStageExecutor` and existing Run/Recovery stores as the orchestration boundary. Add a versioned desktop protocol, Core-side Agent Registry + Job/Lease store, a restricted Desktop Agent runtime with workspace/policy guards, and a `DesktopExecutor` adapter that maps task outcomes back into Harness stage results. The first live proof uses a temporary Git repository only.

**Tech Stack:** TypeScript 7, Node.js 22, `ws` for Core WebSocket server/outbound Agent client, `node:child_process`, existing Harness stores/state machine/recovery, `node:test`, no unrestricted shell abstraction.

**Spec:** `docs/superpowers/specs/2026-09-08-iseol-desktop-execution-bridge-design.md`

## Global Constraints

- Read `docs/HARNESS_ENGINEERING.md` before every implementation task.
- Desktop Agent connection is persistent and outbound from the user machine to Iseol Core.
- Core remains the source of truth for Run, Job, lease, and evidence state.
- Agent may execute only versioned structured operations; no arbitrary unrestricted shell API.
- Every task pack carries `runId`, `jobId`, `stage`, `workspaceRoot`, `policyDigest`, `policySources`, `idempotencyKey`, and `leaseUntil`.
- Agent re-reads locally addressable Harness/AGENTS policy sources and verifies SHA-256 before mutation.
- Workspace access is restricted to explicitly configured roots and the requested workspace subtree.
- Disconnect/reconnect never blindly repeats a mutation; current repository/job reality is reconciled first.
- Unknown contract versions, unsafe paths, stale policy hashes, missing authorization, or conflicting leases fail closed.
- Secrets/raw tokens never enter Run evidence, job receipts, or persisted logs.
- Existing Discord/Web/Harness behavior must remain green throughout this phase.
- All commits use concise English Conventional Commit-style messages.

---
## File structure

- `src/desktop-agent/contracts.ts` — protocol versions, Agent presence, Task Pack, operation, result, and receipt contracts.
- `src/desktop-agent/agent-registry.ts` — authenticated Core-side agent presence/heartbeat registry.
- `src/desktop-agent/job-store.ts` — durable job records, leases, attempts, results, and idempotency lookup.
- `src/desktop-agent/workspace-guard.ts` — root/path/policy-source validation for local execution.
- `src/desktop-agent/runtime.ts` — structured operation execution and local result assembly.
- `src/desktop-agent/transport.ts` — message/session boundary for register, heartbeat, task, result, and reconnect messages.
- `src/desktop-agent/desktop-executor.ts` — `HarnessStageExecutor` implementation over the Agent/Job boundary.
- `src/desktop-agent/reality-inspector.ts` — Agent-backed Git/job reality for Harness recovery.
- `tests/desktop-agent-*.test.ts` — deterministic protocol, guard, lease, runtime, transport, executor, recovery, and E2E coverage.

### Task 1: Versioned Desktop Agent protocol contracts

**Files:**
- Create: `src/desktop-agent/contracts.ts`
- Create: `tests/desktop-agent-contracts.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `ISEOL_DESKTOP_PROTOCOL_VERSION`, `DesktopAgentHello`, `DesktopAgentPresence`, `DesktopTaskPack`, `DesktopOperation`, `DesktopJobResult`, `DesktopJobReceipt`, and strict version/assertion helpers.

- [ ] Write failing tests proving protocol version `1` is accepted while unknown versions fail, operation unions reject unsupported operation types, Task Packs require non-empty `jobId/runId/workspaceRoot/idempotencyKey`, and mutation-capable packs require `policyDigest` plus at least one `policySource`.
- [ ] Run `node --import tsx --test tests/desktop-agent-contracts.test.ts` and confirm RED because the module does not exist.
- [ ] Implement the minimal versioned types and runtime assertions; use discriminated operations for `READ_FILE`, `LIST_DIRECTORY`, `APPLY_PATCH`, `RUN_PROCESS`, `GIT_STATUS`, `GIT_DIFF`, `GIT_BRANCH`, `GIT_COMMIT`, and `CHECK_HTTP` only.
- [ ] Make Task Pack validation reject unsupported versions, blank identity fields, invalid lease timestamps, duplicate operation IDs, and mutation packs without policy provenance.
- [ ] Run the focused test plus `npm run build` and confirm PASS.
- [ ] Register the test in `npm test` and commit `feat: define desktop agent protocol`.
### Task 2: Agent Registry and heartbeat presence

**Files:**
- Create: `src/desktop-agent/agent-registry.ts`
- Create: `tests/desktop-agent-registry.test.ts`

**Interfaces:**
- Consumes: Task 1 `DesktopAgentHello`, `DesktopAgentPresence`.
- Produces: `registerDesktopAgent(root, hello, at)`, `heartbeatDesktopAgent(root, agentId, at)`, `getDesktopAgentPresence(root, agentId, now, timeoutMs)`, `listOnlineDesktopAgents(root, now, timeoutMs)`.

- [ ] Write failing tests for authenticated registration metadata persistence, heartbeat timestamp updates, offline classification after timeout, deterministic online listing, and safe agent IDs that cannot escape the registry root.
- [ ] Add a test proving a second registration for the same `agentId` updates capabilities/workspace roots without creating a second identity record.
- [ ] Run the focused test and confirm RED.
- [ ] Implement atomic JSON persistence under `<root>/agents/<agentId>.json`; presence status is derived from the latest heartbeat instead of persisted as independent truth.
- [ ] Reject empty workspace-root sets and normalize each root without broadening it.
- [ ] Run focused tests plus build and confirm PASS.
- [ ] Register the test and commit `feat: track desktop agent presence`.

### Task 3: Durable jobs, leases, and idempotency

**Files:**
- Create: `src/desktop-agent/job-store.ts`
- Create: `tests/desktop-agent-job-store.test.ts`

**Interfaces:**
- Consumes: Task 1 `DesktopTaskPack`, `DesktopJobResult`, `DesktopJobReceipt`.
- Produces: `createDesktopJob`, `loadDesktopJob`, `acquireDesktopJobLease`, `renewDesktopJobLease`, `completeDesktopJob`, `findDesktopJobByIdempotencyKey`, `listRecoverableDesktopJobs`.

- [ ] Write failing tests for atomic job creation, same idempotency key returning the existing job, conflicting payload reuse rejection, exclusive lease acquisition, expired lease takeover, lease renewal by the current owner only, and completed-job immutability.
- [ ] Write a reconnect test proving a job with expired lease and no terminal result appears in `listRecoverableDesktopJobs` while completed/cancelled jobs do not.
- [ ] Run focused tests and confirm RED.
- [ ] Implement job files under `<root>/jobs/<jobId>/job.json` using temp-file + rename; persist attempts and lease owner/expiry inside the durable job envelope.
- [ ] Compare idempotent payload identity using stable fields (`runId`, `stage`, `workspaceRoot`, `policyDigest`, `idempotencyKey`, operations) rather than timestamps.
- [ ] Run focused tests plus build and confirm PASS.
- [ ] Register the test and commit `feat: persist desktop agent jobs`.
### Task 4: Workspace guard and local structured runtime

**Files:**
- Create: `src/desktop-agent/workspace-guard.ts`
- Create: `src/desktop-agent/runtime.ts`
- Create: `tests/desktop-agent-runtime.test.ts`

**Interfaces:**
- Consumes: Task 1 `DesktopTaskPack` and operation/result contracts.
- Produces: `assertWorkspaceAccess`, `verifyDesktopTaskPolicy`, `executeDesktopTaskPack(pack, runtimeDeps)`.

- [ ] Write failing path tests for allowed workspace descendants, sibling/parent traversal rejection, symlink-resolved escape rejection, and access outside configured agent roots.
- [ ] Write failing policy tests proving locally addressable policy sources are re-read and SHA-256 verified before mutation, missing mandatory sources fail closed, and read-only operations can still run only inside guarded paths.
- [ ] Write failing runtime tests for file read/list, patch application, bounded process execution, Git status/diff/branch/commit, HTTP check, stdout/stderr truncation, timeout classification, and operation-order preservation.
- [ ] Run focused tests and confirm RED.
- [ ] Implement canonical path resolution using realpath where existing paths allow it and parent realpath + basename checks for creation targets; never trust string-prefix checks alone.
- [ ] Implement process execution using executable + args + cwd, explicit timeout, capped output, and no shell interpolation. `GIT_COMMIT` uses explicit message and fails when working tree has nothing to commit.
- [ ] Verify policy hashes immediately before the first mutating operation and reject stale/unsupported Task Packs before any mutation.
- [ ] Run focused tests plus build and confirm PASS.
- [ ] Register the test and commit `feat: execute guarded desktop tasks`.

### Task 5: Authenticated transport/session boundary

**Files:**
- Create: `src/desktop-agent/transport.ts`
- Create: `src/desktop-agent/ws-server.ts`
- Create: `src/desktop-agent/ws-client.ts`
- Create: `tests/desktop-agent-transport.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 protocol and Task 2 Registry.
- Produces: `DesktopAgentSession`, `acceptDesktopAgentHello`, `handleDesktopAgentMessage`, transport-agnostic `sendTask`/`awaitResult` boundary plus `startDesktopAgentWebSocketServer()` and `connectDesktopAgentWebSocketClient()`.

- [ ] Write failing tests for token-authenticated hello, protocol-version rejection, heartbeat registration, duplicate live-session replacement, task delivery correlation by `jobId`, unknown result rejection, and disconnect marking the session unavailable without deleting durable presence/job records.
- [ ] Add a test proving authentication material is compared but never copied into persisted Agent presence or returned task results.
- [ ] Run focused tests and confirm RED.
- [ ] Add runtime dependency `ws` and dev dependency `@types/ws`; implement a transport-neutral session manager first, then a Core WebSocket server adapter and outbound Agent client adapter that only translate socket frames into session-manager messages.
- [ ] Treat reconnect as a new ephemeral session for the same durable `agentId`; only one active session may own delivery for that agent. Add an integration test using an actual loopback WebSocket server/client proving authenticated hello, heartbeat, task, result, disconnect, and reconnect.
- [ ] Run focused tests plus build and confirm PASS.
- [ ] Register the test and commit `feat: authenticate desktop agent sessions`.
### Task 6: DesktopExecutor and recovery integration

**Files:**
- Create: `src/desktop-agent/desktop-executor.ts`
- Create: `src/desktop-agent/reality-inspector.ts`
- Modify: `src/harness/recovery.ts`
- Create: `tests/desktop-agent-executor.test.ts`
- Create: `tests/desktop-agent-recovery.test.ts`

**Interfaces:**
- Consumes: existing `HarnessStageExecutor`, Agent Registry, Job Store, transport session, runtime result/evidence contracts.
- Produces: `createDesktopStageExecutor(deps): HarnessStageExecutor`, `createDesktopRealityInspector(deps): HarnessRealityInspector`.

- [ ] Write failing executor tests proving offline agent returns `waiting-agent`, online agent creates/leases one durable job, completed results become stage-matching Harness evidence, retryable agent failures map to `retryable-failure`, protected authorization failures map to `blocked-user`, and duplicate executor calls reuse the same idempotent job.
- [ ] Write failing recovery tests proving reconnect inspects Git branch/commit and unfinished job receipt before redispatch, an already completed `GIT_COMMIT` is reconciled instead of repeated, and active foreign lease prevents duplicate dispatch.
- [ ] Run focused tests and confirm RED.
- [ ] Implement stage-to-task compilation only for deterministic desktop-owned work in this phase; open-ended `ANALYZE`, `PLAN`, or reasoning-dependent `IMPLEMENT` without a supplied Task Pack returns `waiting-external` for the later ChatGPT Web bridge.
- [ ] Convert successful operation results into minimal secret-free Harness evidence with stable references to job/receipt IDs; keep large logs outside evidence and reference them by digest/path.
- [ ] Extend reality inspection additively so existing PR/deployment recovery behavior remains unchanged while Agent/job/Git reality can prevent desktop duplicate mutations.
- [ ] Run executor/recovery tests plus all existing Harness recovery/supervisor tests and build; confirm PASS.
- [ ] Register tests and commit `feat: bridge desktop agent to harness runs`.

### Task 7: Fake-agent and temporary-repository E2E

**Files:**
- Create: `tests/desktop-agent-e2e.test.ts`
- Create: `src/desktop-agent/test-support/fake-agent.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: all Tasks 1-6.
- Produces: deterministic in-process fake Agent and end-to-end proof over a temporary Git repository.

- [ ] Write an E2E test that creates a temporary Git repo with a harness file, registers a fake outbound agent, creates a preflight-ready Run/task, applies a file change, runs a test command, inspects Git state, commits once, and returns evidence through `HarnessStageExecutor` without directly mutating Run state outside Supervisor APIs.
- [ ] Add disconnect/reconnect E2E: disconnect after commit result is locally true but before Core records terminal job result, expire the lease, reconnect, reconcile Git reality, and prove commit count remains exactly one.
- [ ] Add policy-drift E2E: change the local harness file after Task Pack compilation and prove mutation is rejected before the target file changes.
- [ ] Add workspace-escape E2E: request an operation outside the temporary allowed root and prove no outside file is created/read.
- [ ] Run focused E2E tests and confirm RED before missing integration pieces are added.
- [ ] Implement only the smallest test-support glue required to make the real production boundaries pass these scenarios; do not introduce test-only bypasses in production guards.
- [ ] Run E2E tests plus build and confirm PASS.
- [ ] Commit `test: verify desktop execution recovery`.
## Phase verification

- [ ] Re-read `docs/HARNESS_ENGINEERING.md` and the Desktop Execution Bridge spec.
- [ ] Run all `tests/desktop-agent-*.test.ts` focused tests.
- [ ] Run existing Harness supervisor/recovery/side-effect tests.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Confirm existing Discord, Web Control Plane, Project Model, Calendar, GitHub review, Figma, and Notion tests remain green.
- [ ] Confirm no raw token/auth secret appears in Agent Registry files, Job receipts, Harness evidence, or test snapshots.
- [ ] Confirm no unrestricted shell command field exists in protocol/runtime contracts.
- [ ] Confirm workspace escape, stale policy, duplicate commit, expired lease, foreign lease, offline agent, disconnect, reconnect, and unknown protocol-version tests all pass.
- [ ] Run the temporary-repository live smoke locally with no external provider side effects and record branch/commit/job/lease/evidence observations.
- [ ] Record exact verification counts and implementation notes in this plan.

## Phase completion gate

The phase is complete only when a preflight-ready Run can delegate deterministic desktop work to an authenticated outbound Agent, enforce workspace and policy provenance locally, persist job/lease state, survive disconnect/reconnect without duplicate mutation, return structured evidence to the existing Run Supervisor, and leave all existing Iseol capabilities green. ChatGPT Web reasoning/session automation remains intentionally unimplemented until the next phase.
