# ISEOL feature inventory

This inventory separates durable implementation, isolated verification, live
verification, and production rollout. A passing fixture test is not treated as
evidence that a ChatGPT Web live run or a deployment succeeded.

| ID | Area | User capability and evidence | Code / API | Tests | Current status | Remaining work |
|---|---|---|---|---|---|---|
| PLAT-01 | Runtime | Single Runtime and maintenance ownership, identity-bound stale-lock inspection/recovery, fail-closed status | `scripts/iseol-runtime-host.ts`, runtime host tests | `tests/iseol-runtime-host.test.ts` | Implemented and isolated-tested | Production recovery requires separate operator approval for the exact lock fingerprint; legacy locks without owner identity remain owner-unconfirmed |
| PLAT-02 | Durable runs | Staged Harness runs, checkpoints, events, recovery and bounded evidence | `src/harness` | harness contract/state/recovery/supervisor suites | Implemented and isolated-tested | Live ChatGPT Web evidence still required |
| PLAT-03 | Web agents | Structured ChatGPT Web extraction, schema validation, correction budget and recovery | `src/chatgpt-web`, `src/harness` | chatgpt-web contract/recovery/e2e suites | Implemented and isolated-tested | Real browser/session verification remains environment-dependent |
| PLAT-04 | Desktop | Capability-gated jobs, leases, revisions, idempotency, path/process policy and results | `src/desktop-agent` | desktop lifecycle, transport, recovery and e2e suites | Implemented and isolated-tested | Production pending jobs remain untouched by this work |
| PLAT-05 | Operator recovery | Approval bootstrap, single-use revision-bound approval, containment and multi-job maintenance batch | `src/desktop-agent/operator-reconciliation.ts`, `scripts/iseol-runtime-host.ts` | containment/runtime-host suites | Implemented and isolated-tested | Requires separate human approval per production action |
| IDEA-01 | Idea Lab dashboard | Global campaigns, productions and prototype projection | `GET /api/idea-lab`, `src/web-control-plane/view-model.ts` | web control-plane and Idea Lab suites | Implemented and tested | Static client remains the current UI shell |
| IDEA-02 | Campaign detail | Campaign-specific productions and prototypes projection and selectable detail panel | `GET /api/idea-lab/campaigns/:campaignId`, `web/app.js` | router/view-model/server/static suites | Implemented and isolated-tested | Real browser acceptance remains |
| IDEA-03 | Prototype detail | Candidate metadata, origin, genesis Run summaries and preview/promotion actions | `GET /api/prototypes/:prototypeId`, `web/app.js` | router/view-model/server/static suites | Implemented and isolated-tested | Real preview/deployment acceptance remains |
| IDEA-04 | Idea generation/production | Distinct proposals, bounded concurrent productions, deployment evidence and promotion | `src/idea-lab` | Idea Lab stores, supervisor, production, E2E suites | Implemented and isolated-tested | Real external provider/live prototype verification required |
| IDEA-05 | Recovery barrier | WAITING_EXTERNAL production suppresses automatic campaign recovery while preserving budget/state | `src/idea-lab/runtime-service.ts` | runtime-service and recovery suites | Implemented and isolated-tested | Historical production request remains UNKNOWN in old Runtime |
| PROJ-01 | Project Workspace | Prototype promotion preserves origin, workspace tree/history and Run projections | `src/project-model`, `GET /api/projects/:id` | project model/promotion/tree/router suites | Implemented and isolated-tested | Long-running work-request UI/API is partial |
| PROJ-02 | Purpose profiles | User-facing purpose selection maps to bounded execution profile and durable portfolio evidence | `src/project-model/execution-profile.ts`, portfolio stores | purpose-profile and portfolio suites | Implemented and isolated-tested | Live user acceptance still required |
| PROJ-03 | Project execution | Prepare/start project Run through existing control-plane actions | `POST /api/projects/:id/execution-start` | purpose-profile/router suites | Partially implemented | Explicit resume UX remains; queue execute now delegates to this official path |
| PROJ-05 | Work queue | Durable project work request creation, dependency gating, explicit execution, cancellation, single-worker claim and read-only reconciliation | `src/project-model/work-request.ts`, `/api/projects/:id/work-requests` | `tests/project-work-request.test.ts`, router/server tests | Implemented and isolated-tested | Runtime scheduler invocation and browser acceptance remain; automatic startup execution is intentionally disabled |
| PROJ-04 | Project history | Durable tree/history records connect Runs and evidence | `src/project-model/history-store.ts`, `workspace-store.ts` | project model/history suites | Implemented and isolated-tested | Commit/PR/deploy evidence needs live provider verification |
| UI-01 | Browser UI | Static Idea Lab and Project Workspace controls, status and portfolio views | `web/index.html`, `web/app.js`, `web/styles.css` | static/server and router suites | Implemented as current shell; integration partial | Browser interaction tests remain unavailable in this environment |
| UI-02 | Live updates | Authenticated bounded SSE refresh channel and fetch-based UI re-sync | `src/web-control-plane/event-bus.ts`, `server.ts`, `GET /api/events`, `web/app.js` | `tests/web-control-plane-server.test.ts` | Implemented and isolated-tested | Durable replay cursor is not implemented; reconnect re-fetches snapshots; real browser acceptance remains |
| DISC-01 | Discord calendar/code review | Existing calendar and code-review commands/providers | `src/services`, `src/discord-*` | calendar/review suites | Implemented and tested | External credential/live Discord verification required |
| DISC-02 | Project status/agent notifications | Web Product event bridge, bounded facts, durable delivery states, binding-aware Discord.js adapter | `src/discord-project/progress-event-bridge.ts`, `progress-notifications.ts`, `progress-discord-adapter.ts` | progress notification, adapter and bridge suites | Implemented and isolated-tested | Runtime must inject the existing Discord client/adapter; real Discord account remains unverified |
| EXT-01 | GitHub | Webhooks, commit feed, PR/review and CI integrations | `src/services/github*`, webhook server | GitHub/review suites | Implemented in bounded adapters | Real repository authorization and webhook verification required |
| EXT-02 | Deployment | Idea Lab deployment adapters record URL/provider/result | `src/idea-lab/vercel-deploy-adapter.ts` | deployment adapter/live-smoke suites | Implemented as adapter | Real deployment is not performed in this task |
| OPS-01 | Production recovery | Old Runtime state, prod-8 UNKNOWN, WAITING_AGENT and pending mutation preservation, explicit stale Runtime lock recovery | runtime/maintenance stores and operator procedures | isolated maintenance and lock-recovery suites | Code path ready; production rollout blocked | Human approval R for the exact lock fingerprint, then separate B/C containment and D startup approvals; legacy lock owner identity may require external process evidence |

## Evidence boundaries

- `npm test`, focused suites, and `npm run build` establish repository-level
  implementation health only.
- No production Runtime was stopped, no operator token was used, no pending
  Desktop job was contained or redispatched, and no Live Run was created in
  this work.
- The Idea Lab production Run `prod-8` remains `IMPLEMENT / WAITING_EXTERNAL`
  with an UNKNOWN historical external-request outcome. The recovery barrier
  prevents future automatic duplicate scheduling; it does not manufacture a
  completion event for the old Runtime.
- PROJECT-DOGFOOD-01 Run 2 remains `CONTEXT / WAITING_AGENT`; its automatic
  recovery predicate remains false.

## Completion rule

An item is complete only when its durable contract, user/API path, and
appropriate tests exist. Live ChatGPT Web, production Desktop, external
credentials, and deployment claims require separate evidence and are therefore
listed as live or rollout work until actually performed.
