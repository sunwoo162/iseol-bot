import { Octokit } from "@octokit/rest";
import { changedLinesFromPatch, filterReviewFindings } from "./review-filter.js";
import { renderInlineComment, renderReviewBody } from "./review-render.js";
import { ReviewStateStore } from "./review-state.js";
import type { ReviewProvider } from "./gemini-review-provider.js";

export type PullFile = { filename: string; patch?: string | null };

export function isReviewablePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  if (normalized.endsWith("package-lock.json") || normalized.endsWith("pnpm-lock.yaml") || normalized.endsWith("yarn.lock")) return false;
  if (normalized.includes("/node_modules/") || normalized.startsWith("node_modules/")) return false;
  if (normalized.includes("/dist/") || normalized.startsWith("dist/")) return false;
  if (normalized.includes("/build/") || normalized.startsWith("build/")) return false;
  if (normalized.endsWith(".min.js") || normalized.endsWith(".map")) return false;
  return true;
}

export function buildReviewContext(files: PullFile[], maxChars = 50_000): string {
  const chunks: string[] = [];
  let size = 0;
  for (const file of files) {
    if (!isReviewablePath(file.filename) || !file.patch) continue;
    const chunk = `FILE: ${file.filename}\n${file.patch}`;
    if (size + chunk.length > maxChars) break;
    chunks.push(chunk);
    size += chunk.length;
  }
  return chunks.join("\n\n");
}

export class GitHubReviewService {
  private readonly octokit: Octokit;

  constructor(
    token: string,
    private readonly provider: ReviewProvider,
    private readonly state = new ReviewStateStore(),
  ) {
    this.octokit = new Octokit({ auth: token });
  }

  async reviewPullRequest(repository: string, pullNumber: number, headSha: string): Promise<{ skipped: boolean; findings: number }> {
    if (await this.state.hasReviewed(repository, pullNumber, headSha)) return { skipped: true, findings: 0 };
    const [owner, repo] = repository.split("/");
    if (!owner || !repo) throw new Error(`올바르지 않은 GitHub 저장소: ${repository}`);

    const { data: files } = await this.octokit.rest.pulls.listFiles({ owner, repo, pull_number: pullNumber, per_page: 100 });
    const reviewable = files.filter((file) => isReviewablePath(file.filename));
    const context = buildReviewContext(reviewable);
    if (!context.trim()) {
      await this.octokit.rest.pulls.createReview({ owner, repo, pull_number: pullNumber, commit_id: headSha, body: renderReviewBody({ summary: [], findings: [] }), event: "COMMENT" });
      await this.state.markReviewed(repository, pullNumber, headSha);
      return { skipped: false, findings: 0 };
    }

    const changedLines = new Set<string>();
    for (const file of reviewable) {
      for (const key of changedLinesFromPatch(file.filename, file.patch)) changedLines.add(key);
    }
    const normalized = filterReviewFindings(await this.provider.review(context), changedLines);
    const comments = normalized.findings.map((finding) => ({
      path: finding.filePath,
      line: finding.line,
      side: "RIGHT" as const,
      body: renderInlineComment(finding),
    }));
    await this.octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: headSha,
      body: renderReviewBody(normalized),
      event: "COMMENT",
      comments,
    });
    await this.state.markReviewed(repository, pullNumber, headSha);
    return { skipped: false, findings: comments.length };
  }
}
