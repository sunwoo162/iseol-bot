# ISEOL feature inventory

This inventory separates durable implementation, isolated verification, live
verification, and production rollout. A passing fixture test is not treated as
evidence that a ChatGPT Web live run or a deployment succeeded.

| ID | Area | User capability and evidence | Code / API | Tests | Current status | Remaining work |
|---|---|---|---|---|---|---|
| PLAT-01 | Runtime | Single Runtime and maintenance ownership, stale-lock fail-closed behavior | `scripts/iseol-runtime-host.ts`, runtime host tests | `tests/iseol-runtime-host.test.ts` | Implemented and isolated-tested | Production cutover requires operator shutdown and startup approval |
| PLAT-02 | Durable runs | Staged Harness runs, checkpoints, events, recovery and bounded evidence | `src/harness` | harness contract/state/recovery/supervisor suites | Implemented and isolated-tested | Live ChatGPT Web evidence still required |
| PLAT-03 | Web agents | Structured ChatGPT Web extraction, schema validation, correction budget and recovery | `src/chatgpt-web`, `src/harness` | chatgpt-web contract/recovery/e2e suites | Implemented and isolated-tested | Real browser/session verification remains environment-dependent |
| PLAT-04 | Desktop | Capability-gated jobs, leases, revisions, idempotency, path/process policy and results | `src/desktop-agent` | desktop lifecycle, transport, recovery and e2e suites | Implemented and isolated-tested | Production pending jobs remain untouched by this work |
| PLAT-05 | Operator recovery | Approval bootstrap, single-use revision-bound approval, containment and multi-job maintenance batch | `src/desktop-agent/operator-reconciliation.ts`, `scripts/iseol-runtime-host.ts` | containment/runtime-host suites | Implemented and isolated-tested | Requires separate human approval per production action |
| IDEA-01 | Idea Lab dashboard | Global campaigns, productions and prototype projection | `GET /api/idea-lab`, `src/web-control-plane/view-model.ts` | web control-plane and Idea Lab suites | Implemented and tested | Static client remains the current UI shell |
| IDEA-02 | Campaign detail | Campaign-specific productions and prototypes projection | `GET /api/idea-lab/campaigns/:campaignId` | `web-control-plane-router/view-model` detail tests | Implemented in this change and isolated-tested | Wire into a richer campaign page and live updates |
| IDEA-03 | Prototype detail | Candidate metadata, origin and genesis Run summaries | `GET /api/prototypes/:prototypeId` | `web-control-plane-router/view-model` detail tests | Implemented in this change and isolated-tested | Preview interaction and promotion UX need broader UI coverage |
| IDEA-04 | Idea generation/production | Distinct proposals, bounded concurrent productions, deployment evidence and promotion | `src/idea-lab` | Idea Lab stores, supervisor, production, E2E suites | Implemented and isolated-tested | Real external provider/live prototype verification required |
| IDEA-05 | Recovery barrier | WAITING_EXTERNAL production suppresses automatic campaign recovery while preserving budget/state | `src/idea-lab/runtime-service.ts` | runtime-service and recovery suites | Implemented and isolated-tested | Historical production request remains UNKNOWN in old Runtime |
| PROJ-01 | Project Workspace | Prototype promotion preserves origin, workspace tree/history and Run projections | `src/project-model`, `GET /api/projects/:id` | project model/promotion/tree/router suites | Implemented and isolated-tested | Long-running work-request UI/API is partial |
| PROJ-02 | Purpose profiles | User-facing purpose selection maps to bounded execution profile and durable portfolio evidence | `src/project-model/execution-profile.ts`, portfolio stores | purpose-profile and portfolio suites | Implemented and isolated-tested | Live user acceptance still required |
| PROJ-03 | Project execution | Prepare/start project Run through existing control-plane actions | `POST /api/projects/:id/execution-start` | purpose-profile/router suites | Partially implemented | Work-request queue, dependency scheduling and explicit resume UX need completion |
| PROJ-04 | Project history | Durable tree/history records connect Runs and evidence | `src/project-model/history-store.ts`, `workspace-store.ts` | project model/history suites | Implemented and isolated-tested | Commit/PR/deploy evidence needs live provider verification |
| UI-01 | Browser UI | Static Idea Lab and Project Workspace controls, status and portfolio views | `web/index.html`, `web/app.js`, `web/styles.css` | static/server and router suites | Implemented as current shell; integration partial | Campaign/prototype detail navigation, SSE refresh, and browser interaction tests |
| UI-02 | Live updates | Durable event-driven SSE refresh channel | Design specifies `GET /api/events` | No implementation found | Not implemented | Add authenticated bounded event broker and server streaming tests |
| DISC-01 | Discord calendar/code review | Existing calendar and code-review commands/providers | `src/services`, `src/discord-*` | calendar/review suites | Implemented and tested | External credential/live Discord verification required |
| DISC-02 | Project status/agent notifications | Durable project context/status projections and Discord sharing | `src/discord-project` | Discord project/status/context suites | Partially implemented | Notification event mapping and deduplication need product-level acceptance tests |
| EXT-01 | GitHub | Webhooks, commit feed, PR/review and CI integrations | `src/services/github*`, webhook server | GitHub/review suites | Implemented in bounded adapters | Real repository authorization and webhook verification required |
| EXT-02 | Deployment | Idea Lab deployment adapters record URL/provider/result | `src/idea-lab/vercel-deploy-adapter.ts` | deployment adapter/live-smoke suites | Implemented as adapter | Real deployment is not performed in this task |
| OPS-01 | Production recovery | Old Runtime state, prod-8 UNKNOWN, WAITING_AGENT and pending mutation preservation | runtime/maintenance stores and operator procedures | isolated maintenance suites | Code path ready; production rollout blocked | Human approval, quiescence decision, and separate startup approval |

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
