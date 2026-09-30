# Iseol Harness Engineering

This document defines the global execution discipline for every Iseol development Run. Project-specific harness guidance and `AGENTS.md` files may add stricter rules, but they do not replace these invariants.

## Mandatory preflight

Before analysis or any development side effect, a Run must:

1. read this global harness document completely;
2. read the target repository's `docs/HARNESS_ENGINEERING.md` when present;
3. read the target repository's `AGENTS.md` when present;
4. record source paths and SHA-256 digests;
5. persist the resulting policy snapshot;
6. become `ready` only after those steps succeed.

Missing mandatory global guidance fails closed. A Run must never silently continue without its required policy.

## Execution invariants

- Durable Run state is the source of truth; a ChatGPT conversation is a replaceable worker.
- Meaningful stage transitions and external side effects require checkpoints/evidence.
- Completion claims require configured test, review, CI, deployment, and verification evidence.
- External side effects such as PR creation and deployment must be idempotent or reconciled before retry.
- Recovery inspects current Git/provider reality before repeating commands.
- Repeated identical failures use bounded retry and then replan/escalation; infinite retry loops are forbidden.
- Missing or unknown required contract versions fail before mutation.
- Inferred configuration never grants write, GitHub, deployment, or destructive permission silently.
- Secrets, raw tokens, and credentials are never written to Run evidence or policy snapshots.

## Human intervention boundary

Routine reversible work should continue automatically. Iseol pauses only for material product decisions, missing authorization, destructive or irreversible operations, paid actions, or other explicitly protected boundaries.

## Git, commit, and pull request policy

- Commit messages created by Iseol must be written in English and should use a concise Conventional Commit-style prefix such as `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, or `chore:`.
- Before push or PR creation, read the target repository's Git/PR rules and `.github/pull_request_template.md` when present.
- If a repository PR template exists, preserve its headings, order, and language instead of replacing it with an Iseol-specific format.
- If no repository PR contract exists, use a concise title in the form `<type> : <short English description>` and a body covering changes, reason, implementation, impact, verification, and target branch.
- Normal development targets the repository's configured base branch; when no stricter project rule exists, prefer `develop`. Direct `main` integration is reserved for explicit release/hotfix policy.
- Push or PR creation must not happen while required harness verification is failing. Merge and deployment require their configured completion gates to pass.
- Existing CI/CD remains authoritative. Do not add or duplicate a Harness-only workflow merely to satisfy Iseol when the repository already has an appropriate pipeline.
- A Run may authorize routine push, PR, merge, and deployment up front; Iseol must not ask for repetitive approval at every stage unless project-local policy or a protected human-intervention boundary requires it.

## Project-specific policy

A target project's harness document contains repository-specific invariants such as build commands, supported surfaces, protected directories, deployment boundaries, and quality gates. Those rules remain owned by that project.

The effective Run policy is the ordered combination of this global document and all discovered project-local guidance, with provenance retained for audit and recovery.

## Progress notification journal concurrency

- The Discord progress notification journal is one JSONL file per project.
- Durable locking for notification delivery and adapter dispatch is therefore keyed by project journal identity, not by individual event ID.
- Tests must cover different event IDs contending for the same project journal so a new event cannot bypass an in-flight journal read/append operation.

## Daily scrum reminder delivery concurrency

- Daily scrum reminder delivery is coordinated by project and Seoul date, because the reminder state records one successful notification per project per date.
- The durable delivery lock must cover the check, Discord send, and successful state mark as one critical section so concurrent pollers cannot send duplicate `@everyone` reminders.
- A failed Discord send must release the lock without recording the date, allowing a later poll to retry the reminder.

## Contest feed delivery concurrency

- The general contest feed delivery lock is keyed by guild, while an audience-specific feed lock is keyed by guild and audience filter.
- A feed poll must acquire its delivery lock before reading the latest state, then perform external Discord publication and `postedKeys`/`remindedKeys` persistence within that critical section.
- A poll waiting behind another long-running poll must re-read the current state after lock acquisition instead of continuing with its original snapshot.

## GitHub commit feed synchronization

- The GitHub-linked commit feed sync is one external side-effect transaction across state read, Discord commit-log publication, and seen-event/commit persistence.
- A durable sync lock must cover the entire feed run so separate bot processes cannot publish the same linked commit before either process records its seen state.
- The existing in-process polling guard is complementary; it does not replace the durable lock required for multi-process deployment.

## GitHub automation polling synchronization

- GitHub automation polling treats PR review publication, milestone calendar synchronization, and poll-state persistence as one multi-process synchronization boundary.
- The durable sync lock must cover the complete polling run, while the existing in-process `running` guard remains a fast local optimization rather than the correctness boundary.
- A waiting or restarted poll must observe the persisted poll state after the previous run releases the lock before producing further external side effects.

## Figma and Notion integration polling

- Figma version/comment notifications and Notion edit notifications share one ProjectStore integration-polling boundary because each external send is followed by a project cursor update.
- The scheduler must hold the durable polling lock across project discovery, external Discord notification, and cursor persistence so another bot process cannot replay the same provider change.
- The in-process scheduler guard remains useful for avoiding local overlap, but correctness depends on the durable lock shared by all processes.

## GitHub review side-effect synchronization

- CI artifact reviews and signed-webhook AI reviews use the same durable lock keyed by repository, pull request number, and head SHA.
- The review lock covers the `hasReviewed` check, GitHub review publication, and successful review-state mark so concurrent workers cannot both pass the check and publish duplicate reviews.
- Review-state file locking remains responsible for atomic state reads and writes; the per-review lock protects the longer external side-effect transaction across independent bot processes.

## GitHub milestone calendar synchronization

- Milestone calendar synchronization is locked by its canonical calendar external key (`project`, repository, source, and milestone number).
- The mapping lock covers the state lookup, Calendar create/update/delete call, and mapping upsert/remove so concurrent polls cannot create duplicate events for one milestone.
- Calendar mapping file locking still protects atomic state changes; the per-mapping lock protects the longer external Calendar side-effect transaction.

## Contest feed setup synchronization

- General contest setup uses the guild delivery lock, while audience-specific setup uses the guild and audience-filter delivery lock already used by feed polling.
- Setup must re-read feed state after acquiring the lock and keep channel creation, state persistence, and the initial 안내 message in the same critical section.
- This prevents concurrent setup commands from creating duplicate contest categories or channels across independent bot processes.

## Discord channel ensure synchronization

- Project discussion and contest preparation announcement channel repair use a shared durable ensure-lock helper.
- The lock scope is the owning guild and category, so a retry or second bot process re-fetches channels after waiting and only creates missing channels.
- Different categories remain independent, while the check, Discord channel creation, and position adjustment for one category are serialized.

## Contest vote finalization synchronization

- Contest vote handling uses a durable lock keyed by vote ID in addition to the local in-process duplicate-click guard.
- The lock covers the fresh vote read, majority decision, preparation-room channel creation, vote-state update, and related Discord notifications.
- A worker waiting behind another process therefore observes the finalized vote before attempting another preparation-room side effect.

## Daily scrum channel setup synchronization

- `/scrum create` uses the shared Discord channel ensure lock keyed by the project guild and category.
- The command re-fetches the daily scrum channel after acquiring the lock and creates it only when still missing.
- Channel creation, discussion-channel position adjustment, and the initial usage message are kept inside the same critical section.

## Project creation synchronization

- `/project create` uses a durable lock keyed by the guild and the NFKC-normalized, case-insensitive project name.
- After acquiring the lock, the command re-reads the project store and Discord categories before creating the category, preventing duplicate project spaces across bot processes.
- The lock remains held through category/channel setup, integration side effects, and project persistence so a concurrent request cannot begin the same external setup from an old snapshot.

## Project name uniqueness invariant

- `ProjectStore.save` enforces one NFKC-normalized, case-insensitive project name per guild inside the durable file mutation lock.
- A duplicate name is rejected before the record is persisted, while the same name remains valid in a different guild.
- This storage invariant complements the `/project create` lifecycle lock and protects alternate callers that bypass the Discord command.

## Deterministic full-suite execution

- The default `npm test` command runs the complete test list with `--test-concurrency=1`.
- This keeps Windows/Desktop Agent integration tests from contending for shared process, socket, and temporary-file resources.
- Focused tests may still opt into their own concurrency when their fixtures are isolated, but the repository-wide gate remains deterministic.

## Project deletion synchronization

- `/project delete` uses a durable lock keyed by guild and project ID, so concurrent requests for one project share the same critical section even when they arrive through different target text.
- After acquiring the lock, the command re-reads the project store and Discord channels before deleting external webhooks, calendars, channels, bindings, and stored state.
- A request waiting behind a completed deletion observes the missing project and does not repeat external cleanup side effects from its stale pre-lock snapshot.

## Contest audience category synchronization

- Audience-specific contest feed setup uses a guild-scoped Discord channel lock for the shared `🏆 공모전` category.
- The category ensure critical section re-reads cached and fetched Discord channels before creating the category, so filters with independent delivery locks reuse one category.
- The audience delivery lock remains filter-scoped for independent feed channels, while only the shared category side effect is serialized across filters.

## Shared contest category synchronization

- Base `/contest setup` and audience-specific feed setup share the guild-scoped `contest-category` lock for the common `🏆 공모전` category.
- Both paths re-read Discord channels inside that lock and reuse an existing category, including one created by the other service.
- Base feed rollback deletes the category only when the base setup created it; a pre-existing shared category is preserved when channel setup fails.

## Project discussion repair synchronization

- Startup and post-command project discussion repair shares the project deletion lock keyed by guild and project ID.
- Repair re-reads the stored project after acquiring that lock and skips channel creation when deletion has already removed the project.
- The Discord category/channel ensure lock remains nested for channel-level duplicate prevention, while the lifecycle lock coordinates repair with project deletion.
