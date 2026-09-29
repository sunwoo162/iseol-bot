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
