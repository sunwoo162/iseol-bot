import { Octokit } from "@octokit/rest";
import type { RepositoryRef } from "./github.js";
import type { PolledMilestone } from "./github-automation-polling-domain.js";

export type PolledPullRequest = {
  number: number;
  headSha: string;
};

export class GitHubAutomationSource {
  private readonly octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async listOpenPullRequests(repository: RepositoryRef): Promise<PolledPullRequest[]> {
    const pulls = await this.octokit.paginate(this.octokit.rest.pulls.list, {
      owner: repository.owner,
      repo: repository.repo,
      state: "open",
      per_page: 100,
    });

    return pulls.map((pull) => ({
      number: pull.number,
      headSha: pull.head.sha,
    }));
  }

  async listMilestones(repository: RepositoryRef): Promise<PolledMilestone[]> {
    const milestones = await this.octokit.paginate(this.octokit.rest.issues.listMilestones, {
      owner: repository.owner,
      repo: repository.repo,
      state: "all",
      per_page: 100,
    });

    return milestones.map((milestone) => ({
      number: milestone.number,
      title: milestone.title,
      dueOn: milestone.due_on ?? null,
      state: milestone.state === "closed" ? "closed" : "open",
      htmlUrl: milestone.html_url,
      updatedAt: milestone.updated_at ?? milestone.created_at ?? "",
    }));
  }
}
