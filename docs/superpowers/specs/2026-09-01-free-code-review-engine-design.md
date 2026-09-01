# Free Code Review Engine Design

## Goal
Build a zero-API-cost code review system that keeps the existing Gemini-like GitHub UX: a compact `🤖 이설 Code Review` summary plus only actionable inline comments on changed lines.

## Constraints
- No paid LLM/API is required for normal reviews.
- Production must not require an inbound public webhook port.
- Reviews are triggered from the existing 1-minute outbound GitHub polling loop.
- Private repositories must be able to run without GitHub-hosted runner minute charges by using a self-hosted runner.
- Never execute fork PR code on the trusted self-hosted runner.
- Existing HEAD SHA deduplication and changed-line validation remain authoritative.
- No style-only noise: formatter/semicolon/quote/line-length findings are excluded from inline review.
- One normal review is capped at 5 inline comments, except critical-security overflow may be kept.

## Architecture

```text
Pull Request
   |
   v
GitHub Actions workflow: Iseol Code Review
   |
   +-- project-native checks
   |    +-- install
   |    +-- lint
   |    +-- typecheck
   |    +-- test
   |    +-- build
   |
   +-- analyzers
        +-- ESLint JSON
        +-- TypeScript diagnostics
        +-- npm audit JSON
        +-- Knip
        +-- dependency-cruiser
        +-- Semgrep (when installed)
        +-- Gitleaks (when installed)
        +-- Trivy (when installed)
        +-- OSV-Scanner (when installed)
        +-- actionlint (workflow files)
        |
        v
   normalized iseol-review.json artifact
        |
        v
Iseol 1-minute outbound poller
        |
        +-- locate completed workflow for PR HEAD SHA
        +-- download `iseol-review-findings` artifact
        +-- normalize/dedupe findings
        +-- reject findings outside added RIGHT-side lines
        +-- confidence/severity/noise filters
        +-- max 5 ordinary inline comments
        |
        v
GitHub Review API
   +-- inline comments on Files changed
   +-- compact `🤖 이설 Code Review` body
```

## Workflow safety
The workflow uses `runs-on: [self-hosted, linux, x64, iseol-review]` and runs only when `github.event.pull_request.head.repo.full_name == github.repository`. Pull requests from forks are skipped so untrusted fork code cannot execute on the trusted server.

The workflow requests only the minimum permissions needed to read source and upload the findings artifact. It does not receive production secrets.

## Normalized finding contract

```ts
type CiReviewFinding = {
  tool: string;
  filePath: string;
  line: number;
  severity: "critical" | "major" | "minor";
  category: "correctness" | "security" | "performance" | "maintainability";
  confidence: number;
  explanation: string;
  suggestion?: string;
  ruleId?: string;
};

type CiReviewArtifact = {
  schemaVersion: 1;
  repository: string;
  pullNumber: number;
  headSha: string;
  generatedAt: string;
  checks: Array<{
    name: string;
    status: "passed" | "failed" | "skipped";
    detail?: string;
  }>;
  findings: CiReviewFinding[];
};
```

## Aggregation rules
1. Only comments targeting lines added on the RIGHT side of the PR diff are eligible.
2. Exact duplicates are removed by `filePath + line + normalized explanation/rule`.
3. Multiple tools confirming the same location/category raise confidence.
4. Security findings from secret scanners are treated as high confidence.
5. Style-only findings are not posted as inline reviews.
6. Build/test/typecheck failures without a reliable changed-line mapping stay in the compact review summary/check status instead of being attached to an arbitrary line.
7. Ordinary inline findings are sorted by severity/confidence and capped at five.
8. The same repository + PR + HEAD SHA + artifact is never reviewed twice.

## Project onboarding
When a project is created, Iseol attempts to install `.github/workflows/iseol-code-review.yml` into both configured repositories if the file does not already exist. Existing projects get a one-shot bootstrap command/script.

The generated workflow references the central review collector script in this repository at a pinned commit/ref. The collector is responsible for producing the normalized artifact and must never post GitHub comments itself; comment posting remains centralized in Iseol.

## Self-hosted runner
The production `gsmsv` host will use a dedicated GitHub Actions runner labeled `iseol-review` and a separate working directory/user where practical. GitHub documents self-hosted runner usage as free from GitHub Actions runner charges; machine hosting cost remains the operator's responsibility.

A setup helper installs optional analyzers and validates their versions. Missing optional analyzers are recorded as `skipped`, not treated as a failed review.

## Failure behavior
- Analyzer crash: record the analyzer as failed/skipped and continue other analyzers.
- Artifact missing: no review is posted; Discord/log warning is emitted once per HEAD SHA.
- Workflow failed before artifact upload: Iseol summarizes the failed check but does not invent line comments.
- Rate-limit/API errors: retry on the next polling cycle; HEAD SHA state is not marked reviewed until a GitHub review is successfully created.
- Fork PR: workflow skipped by design.

## Migration
- Keep the existing signed webhook code as optional fallback, disabled in production.
- Remove Gemini/Groq from the default review execution path.
- Keep the existing `ReviewFinding`, renderers, changed-line parser, and HEAD SHA state where possible.
- CI findings become the default `ReviewProvider` input source.

## Success criteria
- A same-repository PR starts an Iseol self-hosted Actions review.
- The Actions run creates a valid `iseol-review-findings` artifact even when some optional tools are unavailable.
- Within one polling interval after completion, Iseol posts at most five useful inline comments on changed lines and one compact summary.
- Re-polling the same HEAD SHA creates no duplicate review.
- A new push to the PR creates a new run and can create a new review for the new HEAD SHA.
- Fork PR code never runs on the trusted self-hosted runner.
- Normal operation requires no paid AI API and no public inbound port.
