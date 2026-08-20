import { Octokit } from "@octokit/rest";

export type RepositoryRef = {
  owner: string;
  repo: string;
  url: string;
};

export type RepositoryOwner = {
  login: string;
  type: string;
};

const GITHUB_EVENTS = [
  "push",
  "pull_request",
  "issues",
  "issue_comment",
  "release",
  "check_run",
  "check_suite",
] as const;

export function parseGitHubRepository(input: string): RepositoryRef {
  const raw = input.trim();
  const normalized = raw.startsWith("http://") || raw.startsWith("https://")
    ? raw
    : `https://github.com/${raw}`;

  const url = new URL(normalized);
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new Error("GitHub 저장소는 https://github.com/ORG/REPO 형식만 사용할 수 있습니다.");
  }

  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("GitHub 저장소는 https://github.com/ORG/REPO 형식으로 입력해주세요.");
  }

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, "");
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

export class GitHubWebhookService {
  private readonly octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async getRepositoryOwner(repository: RepositoryRef): Promise<RepositoryOwner> {
    const { data } = await this.octokit.rest.repos.get({
      owner: repository.owner,
      repo: repository.repo,
    });

    if (!data.owner?.login || !data.owner.type) {
      throw new Error(`GitHub 저장소 owner 정보를 확인할 수 없습니다: ${repository.url}`);
    }

    return {
      login: data.owner.login,
      type: data.owner.type,
    };
  }

  async createDiscordWebhook(repository: RepositoryRef, discordWebhookUrl: string): Promise<number> {
    const { data } = await this.octokit.rest.repos.createWebhook({
      owner: repository.owner,
      repo: repository.repo,
      name: "web",
      active: true,
      events: [...GITHUB_EVENTS],
      config: { url: `${discordWebhookUrl}/github`, content_type: "json", insecure_ssl: "0" },
    });
    return data.id;
  }

  async deleteWebhook(repository: RepositoryRef, hookId: number): Promise<void> {
    await this.octokit.rest.repos.deleteWebhook({ owner: repository.owner, repo: repository.repo, hook_id: hookId });
  }

  async deleteDiscordWebhooks(repository: RepositoryRef): Promise<number> {
    const { data: hooks } = await this.octokit.rest.repos.listWebhooks({
      owner: repository.owner,
      repo: repository.repo,
      per_page: 100,
    });

    let deleted = 0;
    for (const hook of hooks) {
      const target = typeof hook.config.url === "string" ? hook.config.url : "";
      if (!target) continue;

      let url: URL;
      try {
        url = new URL(target);
      } catch {
        continue;
      }

      const host = url.hostname.toLowerCase();
      const isDiscord = host === "discord.com" || host === "www.discord.com" || host === "discordapp.com" || host === "www.discordapp.com";
      const isProjectWebhook = url.pathname.includes("/api/webhooks/") && url.pathname.endsWith("/github");
      if (!isDiscord || !isProjectWebhook) continue;

      await this.deleteWebhook(repository, hook.id);
      deleted += 1;
    }

    return deleted;
  }

  async inviteOrganizationMember(org: string, username: string): Promise<void> {
    const { data: user } = await this.octokit.rest.users.getByUsername({ username });
    await this.octokit.rest.orgs.createInvitation({ org, invitee_id: user.id, role: "direct_member" });
  }
}
