# ISEOL feature inventory

> 2026-09-21 update: the original table below is retained as historical evidence.
> The dated review appended below supersedes its current-status claims (including
> browser unavailability, pending production recovery, and Discord bootstrap wiring).
> Start at [docs index](README.md); operational observations are in
> [system review](audits/2026-09-21-system-review.md).

This inventory separates durable implementation, isolated verification, live
verification, and production rollout. A passing fixture test is not treated as
evidence that a ChatGPT Web live run or a deployment succeeded.

| ID | Area | User capability and evidence | Code / API | Tests | Current status | Remaining work |
|---|---|---|---|---|---|---|
| PLAT-01 | Runtime | Single Runtime and maintenance ownership, identity-bound stale-lock inspection/recovery, fail-closed status | `scripts/iseol-runtime-host.ts`, runtime host tests | `tests/iseol-runtime-host.test.ts` | Implemented and isolated-tested | Production recovery requires separate operator approval for the exact lock fingerprint; legacy locks without owner identity remain owner-unconfirmed |
| PLAT-02 | Durable runs | Staged Harness runs, checkpoints, events, recovery and bounded evidence | `src/harness` | harness contract/state/recovery/supervisor suites | Implemented and isolated-tested | Live ChatGPT Web evidence still required |
| PLAT-03 | Web agents | Structured ChatGPT Web extraction, schema validation, correction budget and recovery | `src/chatgpt-web`, `src/harness` | chatgpt-web contract/recovery/e2e suites | Implemented and isolated-tested | Real browser/session verification remains environment-dependent |
| PLAT-04 | Desktop | Capability-gated jobs, leases, revisions, idempotency, path/process policy and results | `src/desktop-agent` | desktop lifecycle, transport, recovery and e2e suites | Implemented and isolated-tested | Production pending jobs remain untouched by this work |
| PLAT-05 | Operator recovery | DPAPI-bound first-operator bootstrap/rotation, single-use revision-bound approval, containment and multi-job maintenance batch | `src/runtime/operator-credentials.ts`, `src/desktop-agent/operator-reconciliation.ts`, `scripts/iseol-runtime-host.ts` | `tests/operator-credentials.test.ts`, containment/runtime-host suites | Implemented and isolated-tested | Windows operator bootstrap is required before production recovery; separate human approval remains required per action |
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
| OPS-01 | Production recovery | Old Runtime state, prod-8 UNKNOWN, WAITING_AGENT and pending mutation preservation, PID-bound controlled external stop, explicit stale Runtime lock recovery and lock-only recovery for already-contained jobs | runtime/maintenance stores, `scripts/iseol-runtime-host.ts`, `docs/ISEOL_RUNTIME_RECOVERY.md` | isolated maintenance and lock-recovery suites (`tests/iseol-runtime-host.test.ts`) | Code path ready; production rollout blocked | Separate operator approval for `operator-stop`; exact PID/creation-time/fingerprint and no active lease required. Use `maintenance-recover-stale-lock` only after external PID termination and when no job containment is required; separate D startup approval remains required |

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

## 2026-09-21 전 영역 재검토

상태: **1** 구현+실제 사용자 흐름 검증, **2** 구현+사용자 흐름 미검증,
**3** 부분 구현, **4** 설계만, **5** 미구현, **6** 확인 불충분.
아래 상태는 기능군 기준이다. 하위 fixture PASS가 기능군 전체 acceptance를 뜻하지 않는다.
모든 테스트 경로는 `tests/`, 모든 코드 경로는 저장소 기준이다.
브라우저 `사용자 관찰`은 사용자가 인증 후 보고한 관찰이며 이번 세션의 자동 브라우저 검증이 아니다.
외부 `미검증`은 과거 실행 흔적이 전혀 없다는 뜻이 아니라 성공을 재확인하지 않았다는 뜻이다.

| ID/상태 | 기능/사용자 경험 | 코드, UI/API 또는 명령 | durable/권한/재개 | 테스트 증거 | 브라우저 / 외부 / 남은 작업 |
|---|---|---|---|---|---|
| PLAT-01/2 | owner/status/version/중복 기동 차단 | `scripts/iseol-runtime-host.ts`; status/maintenance-status/start/stop | Runtime/maintenance/recovery lock; operator | `iseol-runtime-host.test.ts`, `iseol-runtime-disposal.test.ts` | 운영 running/verified 직접 확인; Windows 종료와 legacy 경계 유지 |
| PLAT-05/2 | 보호 operator bootstrap/rotate/통제 종료/lock-only recovery | `src/runtime/operator-credentials.ts`, CLI operator-* | DPAPI+Windows SID, exact fingerprint/creation time | `operator-credentials.test.ts`, runtime-host | 과거 사용자 bootstrap/recovery 성공 보고; 이번 실행 안 함; env 설명 일부 낡음 |
| PLAT-02/2 | stage/checkpoint/승인/실행 기록/재개 | `src/harness` | Run/event/approval/side-effect ledger; unknown 보존 | `harness-*.test.ts` | 외부 미검증; completion gate를 제안만으로 통과 금지 |
| PLAT-03/2 | 실제 웹 AI reasoning/추출/교정 | `src/chatgpt-web` | session/turn/intent; schema/correction/recovery budget | `chatgpt-web-*.test.ts` | prod-8 실행 흔적은 있음; 성공 앱 미검증; 임의 API/Codex 대체 금지 |
| PLAT-06/2 | IMPLEMENT patch transport/진단 | `patch-frame-contract.ts`, `patch-diagnostics.ts`, prompt/intent compiler | PATCH_FRAME_V1, bounded diagnostics | reasoning/intent/patch 관련 suite | live extraction 원문 훼손 여부는 새 evidence 필요 |
| PLAT-04/2 | Desktop capability/경로/process/lease/result | `src/desktop-agent`, WebSocket 8791 | registry/job/result/containment; workspace allowlist | `desktop-agent-*.test.ts` | TCP agent 연결 확인; 새 파일 작업 미실행 |
| PLAT-07/2 | read-only retry와 mutation reconciliation | desktop executor/recovery/reality-inspector | exact Run/job/attempt; contained 우선 차단 | desktop recovery/e2e/operator reconciliation | 과거 GIT_INIT 불확실성 유지; 파일 존재로 성공 추정 금지 |
| IDEA-01/3 | 캠페인/production 목록 | view-model, GET `/api/idea-lab` | modelRoot/idea-lab; bearer server | web view/router, idea-lab-web-control-plane | 인증된 빈 화면 사용자 관찰; ROOT-01 결함 |
| IDEA-02/2 | campaign 상세/실패·대기 표시 | GET `/api/idea-lab/campaigns/:id`, web/app.js | campaign→production→Run | router/view-model tests | 운영 root 결함으로 실제 acceptance 미완료 |
| IDEA-03/2 | 후보 상세/origin/genesis/preview | GET `/api/prototypes/:id`, web/app.js | prototypes JSON와 deployment evidence | web/idea-lab production suites | READY candidate 현재 0; preview 외부 미검증 |
| IDEA-04/2 | 다양한 후보/병렬 production/추가 생성 | `src/idea-lab/campaign-supervisor.ts`, distinctness/provider/driver; POST campaigns | proposals/productions/events; budget | idea-lab stores/supervisor/e2e | mock AI/provider 포함; 실제 앱 생성 완료 아님 |
| IDEA-05/2 | WAITING_EXTERNAL recovery barrier | runtime-service, shouldRecoverIdeaLabCampaign | Run external unknown 보존 | idea-lab-runtime-service, runtime-services | root 수정 후 발견되는 prod-8으로 barrier 재검증 필수 |
| IDEA-06/3 | 승격/보관/취소/명시 retry | promotion/prototype-actions/router | deterministic project ID, genesis/history | promotion/idea-lab/web suites | 분리 root 승격 후 조회 위험 PROMO-01; retry는 새 승인 필요 |
| PROJ-01/3 | 기존 workspace 선택/상세 | workspace-store, GET `/api/projects/:id` | projectModelRoot/projects | model stores, purpose-profile | list API 없음; dropdown은 promoted prototype만 사용 |
| PROJ-02/2 | 목적/역할/실행 계획 | execution-profile, workspace-run-preparation; purpose/execution-preparation | purposeSelection과 실제 executable/planned roles | project-purpose-profile | UI 있음, 실제 역할 다중 동시 협업 증명 아님 |
| PROJ-03/3 | 기존 코드 기반 Run 시작 | router execution-start, runtime project executor/compiler | preflight→superviseHarnessRun, approved Desktop | purpose-profile/runtime-services | unavailable enqueue waiting 보존; live Execute 미실행 |
| PROJ-05/3 | queue 생성/claim/dependency/execute/cancel/inspect | work-request.ts; work-requests API, UI | JSON/idempotency/claim lock/execution identity | project-work-request, router | claim은 일시 running; terminal sync/명시 resume/전역 동시성 미완성 |
| PROJ-06/3 | scheduler | scheduleProjectWorkRequests | 명시 승인 caller만; startup 자동 호출 없음 | project-work-request | production 호출 연결 없음; 함수 테스트를 end-to-end worker로 표시 금지 |
| PROJ-04/2 | tree/history/Run evidence 조회 | project-tree/history-store/view-model | immutable Run identity와 history | project tree/history/context | 날짜·커밋·실제 변경 evidence 연결 live 미검증 |
| PROJ-07/3 | evidence 기반 포트폴리오/편집 | portfolio.ts, portfolio-store.ts; portfolio GET/PUT | claim grounding, user edits | purpose-profile 일부; 독립 portfolio suite 없음 | 사용자 귀속/공개 권한/학습 기여 신규 구현 필요 |
| UI-01/3 | Idea Lab/Workspace/Evaluation shell | web/index.html/app.js/styles.css | localStorage web token | static/router/server | 실제 Chrome 기본 로드+사용자 빈 목록 관찰; 전체 acceptance 안 됨 |
| UI-02/2 | fetch SSE/refresh/reconnect | GET `/api/events`, event-bus/server | process-local signal, snapshot 재조회 | web-control-plane-server | durable replay 아님; 실브라우저 재연결 미검증 |
| UI-03/3 | 인증/에러/승인 action 경계 | server/router/operator auth | 단일 Web bearer와 운영자 credential은 별개 | auth/router/server/operator suites | 401 정상; 다중 사용자 인가 미구현; token UI 저장 정리 필요 |
| EVAL-01/2 | fault/recovery/security/provider metrics | src/evaluation; eval:quick/soak, GET `/api/evaluation` | reports/scenario evidence | evaluation-* | 테스트의 runner 호출만 검증; 운영 soak 실행 안 함 |
| DISC-01/2 | 일정 panel/Google Calendar/Issue/milestone | services/calendar, github-schedule-sync | calendar mapping/external key; configured OAuth | calendar-state/calendar-discord/github-schedule-sync | 실제 Calendar/Discord 미검증; 기존 일정 유지 |
| DISC-03/2 | 코드리뷰/CI/collector | services/review, scripts/iseol-review-collector.mjs | review state/artifact/finding dedup | review-*, ci-review-aggregate, collector | 유료 API 없는 기본 CI 경로, optional Gemini fallback 유지 |
| DISC-02/3 | 진행 fact→Discord 전달 | progress-event-bridge/notifications/adapter; src/index.ts opt-in wiring | accepted/failed/unknown/duplicate durable; binding | 3 progress suites | standalone CLI에는 adapter 주입 없음; 이벤트 손실 replay 없음 |
| DISC-04/2 | Discord project 생성/삭제/bind/status/조직 초대 | commands/project, interactions/project-join, services/projects | guild/project binding, 권한 | discord-project-*, interaction-router | 기존 bot project와 Workspace 동일 모델 아님; binding 필요 |
| DISC-05/2 | scrum TODO/DID/일일 알림 | commands/scrum, services/daily-scrum | guild/project/user/date | interaction-router 간접, 전용 suite 확인 안 됨 | 실제 알림 미검증; 강제 기존 메시지 변경 금지 |
| DISC-06/2 | 음성 공부 시간/잔디/자동퇴장 | commands/voice, voice-time/grass/connection/auto-leave | guild/user session/heartbeat | 전용 suite 확인 안 됨 | 시간=활동량, 학습 숙달과 구분 |
| DISC-07/2 | 음악 playlist/play/skip/stop | commands/music, services/music | guild scoped | 전용 suite 확인 안 됨 | 외부 스트림 미검증; 기능 보존 |
| DISC-08/2 | 공모전 필터/투표/재게시/준비 채널 | contest-v2와 contest-* 서비스 | guild feed/vote state | 전용 suite 확인 안 됨 | 신규 학습/모집과 무관하게 유지 |
| DISC-09/6 | 관리 초기화/도움말 | services/guild-reset/command-help, src/index.ts | 관리자 destructive action | 전용 회귀 확인 안 됨 | 코드 존재; 이번 조사 실행 금지, 삭제 의미 유지 |
| EXT-01/2 | GitHub webhook/polling/commit/PR/CI | services/github*, review; `/github connect/profile/disconnect` | signed webhook/poll state/user mapping | github-* suites | username 매핑은 OAuth 로그인 아님; 외부 계정 미검증 |
| EXT-02/2 | 배포 adapter/결과 | idea-lab/vercel-deploy-adapter, completion-profile | provider URL/receipt; gate | vercel-deploy-adapter/live-smoke tests | mock provider는 실제 배포 아님; 일반 Project 배포 UX 별도 확인 필요 |
| EXT-03/3 | Notion/Figma 링크/맥락 참조 | services/notion/figma/project-context | 링크/스냅샷/versions | discord-project-provider-context | 자동 Notion 문서/Figma 디자인 생성 완료 아님 |
| EXT-04/4 | 채용 공고 | commands/job, services/job-feed | 현행 feed no-op, register 목록 제외 | 전용 없음 | 의도적 비활성 상태 보존; 새 팀 모집과 구별 |

### 신규 확정 방향의 현재 수준

| 기능 | 현재 상태 | 기존 기반 / 새 구현 경계 |
|---|---|---|
| 사용자 계정/세션/개인·팀 인가 | 4 설계 | guild 분리·operator token은 tenant 인증 대체 불가 |
| 개인 세계·캐릭터 | 4 설계 | UI/store/domain 신규 |
| 개인 AI 장기 기억 | 4 설계 | Run context는 존재; user memory/consent/retrieval 신규 |
| 경험치·스탯·레벨·업적 | 4 설계 | voice time/Git activity는 입력 근거 일부; 검증 growth ledger 신규 |
| AI 학습 A–K | 4 설계 | 3입력 UX, plan/session/assessment/review 전부 신규 |
| 학습 기반 스터디 | 4 설계 | Discord 음성 공부와 별도 membership/curriculum/shared task 필요 |
| 사람/AI/혼합 팀 | 4 설계 | execution role profile은 있음; 실제 팀 권한·membership 신규 |
| 친구/채팅/커뮤니티/모집 | 4 설계 | Discord 채널·공모전·조직 초대와 별도 제품 도메인 |
| 검증 가능한 개인 포트폴리오 | 3 부분 | project evidence draft 재사용, user attribution/privacy/학습 링크 신규 |

검토 범위는 주요 제품 기능군, 모든 src 영역/등록 command, 현행 API, 관련 spec/plan와 테스트 목록이다.
모든 과거 커밋의 모든 줄·외부 계정·브라우저 동선을 실행한 감사는 아니다. 전용 테스트가 확인되지 않은 기능을 테스트 완료로 올리지 않았다.
