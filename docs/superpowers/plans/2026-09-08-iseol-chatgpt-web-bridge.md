# Iseol ChatGPT Web Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect durable Iseol Runs to ChatGPT Web as a replaceable reasoning worker that emits validated Desktop intents while preserving Core as execution truth and Desktop Agent as the only repository execution hand.

**Architecture:** Add versioned Web-worker contracts and durable coordination stores, compile deterministic prompts from Run state, validate structured reasoning results and Desktop intents, compile accepted intents into existing `DesktopTaskPack` values, and route stages through one `HybridStageExecutor`. Browser-specific UI automation remains behind a narrow adapter and never writes Harness/Desktop state directly.

**Tech Stack:** TypeScript 7, Node.js 22, existing Harness/Project Model/Desktop Agent modules, `node:test`, SHA-256 via `node:crypto`, JSON/JSONL stores, no unrestricted shell or browser-to-filesystem contract.

**Spec:** `docs/superpowers/specs/2026-09-08-iseol-chatgpt-web-bridge-design.md`

## Global Constraints

- Read `docs/HARNESS_ENGINEERING.md` before every implementation task.
- `HarnessStageExecutor` remains the only Run Supervisor execution boundary.
- ChatGPT Web is reasoning-only; repository/process/Git mutation must pass through existing Desktop Agent contracts and Workspace Guard.
- Every accepted Web result is bound to `runId`, `stage`, `generation`, and current `policySha256`.
- Unknown contract versions, stale generations, stale policy digests, unsafe intents, or workspace mismatches fail closed before Desktop job creation.
- Browser cookies, auth tokens, raw hidden reasoning, unrestricted prompt dumps, and secrets never enter Harness evidence or Project History.
- Same-stage reasoning loops are bounded; repeated malformed/rejected results cannot loop indefinitely.
- GitHub lineage timestamps preserve provider times: commit `committedAt`, PR `openedAt`, `mergedAt`, and `closedAt` when available.
- Existing Discord, Web Control Plane, Project Model, Harness, and Desktop Agent behavior must remain green.
- All commits use concise English Conventional Commit-style messages.

---
## File structure

- `src/chatgpt-web/contracts.ts` — protocol version, worker session, reasoning result, turn, and DesktopIntent contracts/assertions.
- `src/chatgpt-web/session-store.ts` — atomic durable session generations and active-session lookup.
- `src/chatgpt-web/turn-store.ts` — append-only accepted reasoning turns.
- `src/chatgpt-web/intent-store.ts` — idempotent accepted/rejected intent envelopes.
- `src/chatgpt-web/prompt-compiler.ts` — deterministic initial/feedback/recovery prompt payloads and SHA-256 digests.
- `src/chatgpt-web/intent-compiler.ts` — active Run/session/policy validation and `DesktopIntent -> DesktopTaskPack` compilation.
- `src/chatgpt-web/browser-adapter.ts` — narrow browser worker interface; no Harness/Desktop writes.
- `src/chatgpt-web/web-reasoning-executor.ts` — bounded same-stage reasoning/Desktop feedback loop.
- `src/chatgpt-web/hybrid-executor.ts` — `HarnessStageExecutor` router for Web/Desktop/provider owners.
- `src/chatgpt-web/recovery.ts` — lost-generation replacement and late-result rejection helpers.
- `src/chatgpt-web/test-support/fake-browser-adapter.ts` — deterministic scripted Web worker for tests.
- `tests/chatgpt-web-*.test.ts` — contract, store, prompt, compiler, executor, recovery, and E2E coverage.

### Task 1: Versioned Web worker and DesktopIntent contracts

**Files:**
- Create: `src/chatgpt-web/contracts.ts`
- Create: `tests/chatgpt-web-contracts.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `ISEOL_CHATGPT_WEB_PROTOCOL_VERSION`, `WebWorkerSession`, `ReasoningTurn`, `ReasoningTurnResult`, `DesktopIntent`, `assertReasoningTurnResult()`, `assertDesktopIntent()`.

- [ ] Write failing tests proving protocol version `1` only, safe non-empty IDs, valid ISO timestamps, supported reasoning outcomes, and exact DesktopIntent union `READ_CONTEXT | PROPOSE_PATCH | RUN_TEST | RUN_BUILD | GIT_INSPECT | REQUEST_COMMIT | CHECK_HTTP`.
- [ ] Add failing tests proving an intent must carry `runId`, `stage`, `workspaceRoot`, `policySha256`, and must not accept `command`, `shell`, `env`, `token`, `force`, or unknown operation fields.
- [ ] Run `node --import tsx --test tests/chatgpt-web-contracts.test.ts` and confirm RED because the module does not exist.
- [ ] Implement discriminated TypeScript contracts and runtime assertions with `ISEOL_CHATGPT_WEB_PROTOCOL_VERSION = 1`.
- [ ] Make result validation require `blockerReason` only for `blocked-user`, reject duplicate intent IDs, and reject intents whose `runId/stage` disagrees with the containing result; `generation` is validated on the result/session envelope before any intent is accepted.
- [ ] Run the focused test plus `npm run build` and confirm PASS.
- [ ] Register the test in `npm test` and commit `feat: define chatgpt web reasoning contracts`.
### Task 2: Durable session, turn, and intent stores

**Files:**
- Create: `src/chatgpt-web/session-store.ts`
- Create: `src/chatgpt-web/turn-store.ts`
- Create: `src/chatgpt-web/intent-store.ts`
- Create: `tests/chatgpt-web-stores.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts.
- Produces: `createWebWorkerSession()`, `loadWebWorkerSession()`, `getActiveWebWorkerSession()`, `replaceLostWebWorkerSession()`, `appendReasoningTurn()`, `listReasoningTurns()`, `recordDesktopIntent()`, `loadDesktopIntent()`.

- [ ] Write failing tests for atomic session creation, one active generation per `(runId, stage)`, generation increment on replacement, safe IDs, and old-generation status becoming `lost` before the replacement becomes active.
- [ ] Write failing append-only turn tests proving duplicate `turnId` with identical semantic content is idempotent while conflicting reuse fails.
- [ ] Write failing intent-store tests proving duplicate `intentId` does not create two records, acceptance/rejection status is durable, and browser credentials/raw prompt bodies cannot be persisted through the public store input.
- [ ] Run `node --import tsx --test tests/chatgpt-web-stores.test.ts` and confirm RED.
- [ ] Implement sessions under `<root>/web-workers/sessions/<sessionId>.json`, active lookup under run/stage metadata, turns as `<root>/web-workers/runs/<runId>/turns.jsonl`, and intents as atomic JSON envelopes.
- [ ] Use deterministic semantic identity for retry-safe writes and temp-file + rename for mutable JSON.
- [ ] Run focused tests plus build and confirm PASS.
- [ ] Register the test and commit `feat: persist chatgpt web worker state`.

### Task 3: Deterministic Prompt Compiler

**Files:**
- Create: `src/chatgpt-web/prompt-compiler.ts`
- Create: `tests/chatgpt-web-prompt-compiler.test.ts`

**Interfaces:**
- Consumes: `HarnessRuntimeRunEnvelope`, active `WebWorkerSession`, prior `ReasoningTurn[]`, optional summarized Desktop evidence.
- Produces: `CompiledWebPrompt { version: 1; kind: "initial" | "feedback" | "recovery"; runId; stage; generation; policySha256; body; sha256 }`, `compileWebPrompt(input)`.

- [ ] Write failing deterministic tests: identical durable inputs produce byte-identical canonical body and SHA-256; changing stage, generation, policy digest, prior decision, or accepted Desktop evidence changes the digest.
- [ ] Add tests proving the prompt includes objective, stage, completion target, policy digest, allowed intent vocabulary, prior decisions, bounded evidence summaries, and recovery marker when `kind === "recovery"`.
- [ ] Add secret-redaction tests using sentinel token/cookie/environment values and prove none appear in `body`.
- [ ] Run the focused test and confirm RED.
- [ ] Implement stable ordered serialization and bounded context construction without depending on conversation history or current wall-clock time.
- [ ] Keep policy source bodies out of the prompt by default; include only policy summary/invariants already present on the Run plus `effectiveSha256`.
- [ ] Run focused tests plus build and confirm PASS.
- [ ] Register the test and commit `feat: compile durable chatgpt web prompts`.
### Task 4: Intent validation and DesktopTaskPack compilation

**Files:**
- Create: `src/chatgpt-web/intent-compiler.ts`
- Create: `tests/chatgpt-web-intent-compiler.test.ts`

**Interfaces:**
- Consumes: active Run, active `WebWorkerSession`, Task 1 `DesktopIntent`, existing `DesktopTaskPack`/policy-source contracts.
- Produces: `validateDesktopIntent(context, intent)`, `compileDesktopIntentToTaskPack(context, intent, agentId, now): DesktopTaskPack`.

- [ ] Write failing tests for run/stage/generation/policy/workspace mismatch rejection and stage-allowed intent matrix: reasoning stages may use context/patch/test/build/inspect; `REQUEST_COMMIT` is accepted only for an explicitly commit-authorized flow; unknown kinds fail closed.
- [ ] Add failing compilation tests: `PROPOSE_PATCH -> APPLY_PATCH`, `RUN_TEST/RUN_BUILD -> RUN_PROCESS`, `GIT_INSPECT -> GIT_INSPECT`, `REQUEST_COMMIT -> GIT_COMMIT`, `CHECK_HTTP -> CHECK_HTTP`; assert the compiler never creates operations absent from the source intent.
- [ ] Add tests proving mutation packs copy the Run preflight policy digest/source hashes, use workspace-relative paths, stable `idempotencyKey = web-intent:<runId>:<intentId>`, and reject raw shell/eval flags or target paths outside `run.request.targetRoot`.
- [ ] Run the focused test and confirm RED.
- [ ] Implement validation before any job-store call and reuse the existing Desktop protocol types/assertions instead of adding a second execution vocabulary.
- [ ] For `RUN_TEST/RUN_BUILD`, accept only a structured executable/args/cwd payload already present in the intent contract; never parse prose into shell text.
- [ ] Run focused tests plus build and confirm PASS.
- [ ] Register the test and commit `feat: compile web reasoning into desktop tasks`.

### Task 5: Browser adapter boundary, WebReasoningExecutor, and generation recovery

**Files:**
- Create: `src/chatgpt-web/browser-adapter.ts`
- Create: `src/chatgpt-web/web-reasoning-executor.ts`
- Create: `src/chatgpt-web/recovery.ts`
- Create: `src/chatgpt-web/test-support/fake-browser-adapter.ts`
- Create: `tests/chatgpt-web-reasoning-executor.test.ts`
- Create: `tests/chatgpt-web-recovery.test.ts`

**Interfaces:**
- Produces `ChatGptWebBrowserAdapter` with `openOrResumeSession`, `submitTurn`, `awaitStructuredResult`, `probeSession`, `closeSession`.
- `createWebReasoningExecutor(deps): HarnessStageExecutor` consumes prompt/session/turn/intent stores, browser adapter, and a Desktop intent runner callback.
- `recoverWebWorkerSession(input)` replaces lost generation and compiles a recovery prompt without changing Run identity.

- [ ] Write failing executor tests proving first reasoning stage creates generation 1, submits a deterministic prompt, accepts a structured turn, records summary/decisions, and returns `completed` only on `stage-complete` with stage-matching reasoning evidence.
- [ ] Add same-stage loop test: turn 1 emits a Desktop intent, fake Desktop runner returns evidence, turn 2 receives that feedback and emits `stage-complete`; assert no direct Desktop transport method exists on the browser adapter.
- [ ] Add bounded-loop tests for max turn count, repeated malformed result, repeated rejected intent, `blocked-user`, and Desktop `waiting-agent` propagation.
- [ ] Write recovery tests for lost session -> mark generation N lost -> generation N+1 created -> recovery prompt includes prior accepted decisions/evidence -> same Run/stage continues.
- [ ] Add stale result tests proving an old generation or old policy digest cannot append a turn or dispatch an intent after replacement.
- [ ] Run focused tests and confirm RED.
- [ ] Implement the adapter interface and scripted fake only; browser-specific selectors/authentication remain outside executor/store code.
- [ ] Implement bounded loop defaults (`maxTurnsPerStage = 8`, `maxRejectedIntents = 3`) and preserve accepted intent identity across adapter retry.
- [ ] Run focused tests plus build and confirm PASS.
- [ ] Register tests and commit `feat: recover chatgpt web reasoning sessions`.
### Task 6: HybridStageExecutor routing and fake-worker + real Desktop E2E

**Files:**
- Create: `src/chatgpt-web/hybrid-executor.ts`
- Create: `tests/chatgpt-web-hybrid-executor.test.ts`
- Create: `tests/chatgpt-web-e2e.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `createHybridStageExecutor({ webExecutor, desktopExecutor, providerExecutor? }): HarnessStageExecutor`.
- Reasoning ownership: `ANALYZE`, `PLAN`, `IMPLEMENT`, `SELF_REVIEW` -> Web executor.
- Deterministic desktop ownership: configured `CONTEXT`, `TEST`, `COMMIT` -> Desktop executor.
- Provider ownership: `PR`, `CI`, `MERGE`, `DEPLOY`, `PRODUCTION_VERIFY` -> existing/injected provider executor; absent provider returns `waiting-external` rather than inventing side effects.

- [ ] Write failing routing tests proving exactly one owner executes each stage and Hybrid executor never mutates Run state itself.
- [ ] Add tests proving an unsupported/unconfigured owner returns `waiting-external` with no browser/Desktop/provider call.
- [ ] Write E2E using a temporary Git repo, real Desktop WebSocket transport/runtime, fake ChatGPT browser worker, real Prompt/Intent compilers, and existing Run Supervisor.
- [ ] E2E sequence: `IMPLEMENT` turn proposes guarded patch + test intent, Desktop Agent applies/executes, second Web turn sees evidence and marks stage complete; later deterministic TEST/COMMIT paths still use Desktop executor.
- [ ] Add interruption E2E: browser generation dies after intent creation while Desktop mutation result is in flight; reconnect/recovery reuses the same intent/job identity and commit/file mutation occurs once.
- [ ] Add stale-policy E2E: mutate harness policy after prompt compilation and prove stale Web output cannot create a Desktop mutation job.
- [ ] Run focused Hybrid/E2E tests and confirm RED before missing glue is implemented.
- [ ] Implement only integration glue required by production boundaries; no fake-only bypass in policy/session/Desktop guards.
- [ ] Run focused E2E, all Desktop Agent tests, Harness supervisor/recovery tests, and build; confirm PASS.
- [ ] Register tests and commit `test: verify chatgpt web reasoning recovery`.

### Task 7: Production browser adapter shell and controlled smoke boundary

**Files:**
- Create: `src/chatgpt-web/production-browser-adapter.ts`
- Create: `src/chatgpt-web/browser-service.ts`
- Create: `tests/chatgpt-web-browser-service.test.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `ChatGptBrowserDriver` narrow driver interface, `createProductionChatGptWebAdapter(driver)`, `resolveChatGptWebBridgeConfig(env)`, and opt-in Core bootstrap for a configured driver.

- [ ] Write failing tests proving Web bridge bootstrap is opt-in, missing browser/auth capability fails closed, session references never persist cookies/profile paths/tokens, and browser driver exposes only conversation open/resume, prompt submit, structured-result read, probe, and close operations.
- [ ] Add adapter tests proving selector/navigation failures classify as recoverable session loss without mutating Run/intent/Desktop stores.
- [ ] Add configuration tests proving no live browser bridge starts merely because Iseol Web or Desktop Agent is enabled.
- [ ] Run focused tests and confirm RED.
- [ ] Implement a production adapter shell over an injected `ChatGptBrowserDriver`; do not add generic browser eval, arbitrary click scripts, shell, file access, or credential extraction APIs.
- [ ] Wire the service into normal Iseol boot only when explicit ChatGPT Web bridge configuration is present; preserve all existing boot paths when absent.
- [ ] Add `chatgpt:web:smoke` script that runs a read/reasoning-only controlled smoke against the configured driver and refuses repository mutation intents unless an explicit temporary test workspace is configured.
- [ ] Run focused browser/config tests plus build and confirm PASS.
- [ ] If a usable authenticated browser driver is available, run the controlled smoke and record the session/generation/structured-result evidence; if authentication/driver capability is unavailable, leave the code green and report the live smoke as the only external blocker rather than bypassing auth.
- [ ] Commit `feat: bootstrap chatgpt web reasoning bridge`.

## Phase verification

- [ ] Re-read `docs/HARNESS_ENGINEERING.md` and the ChatGPT Web Bridge spec.
- [ ] Run all `tests/chatgpt-web-*.test.ts` focused tests.
- [ ] Run all Desktop Agent tests and existing Harness supervisor/recovery/side-effect tests.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Confirm existing Discord, Web Control Plane, Project Model, Calendar, GitHub review, Figma, Notion, and Desktop bootstrap tests remain green.
- [ ] Confirm Web contracts contain no unrestricted shell/browser/file mutation field and production browser adapter has no Harness/Project/Desktop store write dependency.
- [ ] Confirm browser auth material, raw hidden reasoning, tokens, cookies, and profile secrets do not appear in durable session/turn/intent fixtures.
- [ ] Confirm stale generation, stale policy, duplicate intent, browser loss, Desktop loss, indeterminate mutation, and late result tests all pass.
- [ ] Confirm fake-worker + real Desktop temporary-repository E2E records one mutation/job only across interruption recovery.
- [ ] Record exact verification counts, implementation deviations, live-browser smoke state, and GitHub lineage timestamp follow-up status in this plan.

## Phase completion gate

The deterministic bridge is complete when a preflight-ready reasoning stage can create a durable Web worker session, compile a policy-bound prompt, accept a structured fake-Web result, validate/record Desktop intents, execute mutation only through the existing Desktop Agent, feed Desktop evidence into a later reasoning turn, survive generation replacement without duplicate mutation, and leave all existing Iseol capabilities green. Production live-browser smoke additionally requires an authenticated configured browser driver; missing external authentication/driver availability is surfaced as a blocker and never bypassed.
