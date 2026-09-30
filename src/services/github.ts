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

export type RepositoryVisibility = "public" | "private";

const GITHUB_AUTOMATION_EVENTS = ["pull_request", "milestone"] as const;

export function buildAutomationWebhookUrl(publicBaseUrl: string): string {
  const url = new URL(publicBaseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/github/events`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

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
  const invalidRepository = (): never => {
    throw new Error("GitHub 저장소는 https://github.com/ORG/REPO 형식으로 입력해주세요.");
  };
  if (!raw || raw.includes("\\") || /%5c/i.test(raw)) invalidRepository();
  const normalized = raw.startsWith("http://") || raw.startsWith("https://")
    ? raw
    : `https://github.com/${raw}`;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("GitHub 저장소는 https://github.com/ORG/REPO 형식으로 입력해주세요.");
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    invalidRepository();
  }
  if (url.username || url.password || url.port || url.search || url.hash) invalidRepository();

  const pathStart = normalized.indexOf("/", normalized.indexOf("://") + 3);
  const rawPath = (pathStart === -1 ? "" : normalized.slice(pathStart)).split(/[?#]/, 1)[0]!;
  const rawParts = rawPath.split("/");
  if (rawParts[0] !== "") invalidRepository();
  rawParts.shift();
  if (rawParts[rawParts.length - 1] === "") rawParts.pop();
  if (rawParts.length !== 2 || rawParts.some((part) => part === "" || part === "." || part === "..")) {
    invalidRepository();
  }

  let parts: string[];
  try {
    parts = rawParts.map(decodeURIComponent);
  } catch {
    throw new Error("GitHub 저장소는 https://github.com/ORG/REPO 형식으로 입력해주세요.");
  }
  if (
    parts.length !== 2 ||
    parts.some((part) => /[\\/\u0000-\u001f\u007f?#]/.test(part) || /%(?:2f|5c|3f|23)/i.test(part))
  ) {
    invalidRepository();
  }

  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo) || !/[A-Za-z0-9]/.test(repo) || repo === ".git") {
    invalidRepository();
  }
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

export class GitHubWebhookService {
  private readonly octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async getRepositoryOwner(repository: RepositoryRef): Promise<RepositoryOwner> {
    const { data } = await this.octokit.rest.repos.get({ owner: repository.owner, repo: repository.repo });
    if (!data.owner?.login || !data.owner.type) {
      throw new Error(`GitHub 저장소 owner 정보를 확인할 수 없습니다: ${repository.url}`);
    }
    return { login: data.owner.login, type: data.owner.type };
  }

  async getRepositoryVisibility(repository: RepositoryRef): Promise<RepositoryVisibility> {
    const { data } = await this.octokit.rest.repos.get({ owner: repository.owner, repo: repository.repo });
    return data.private ? "private" : "public";
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

  async createAutomationWebhook(repository: RepositoryRef, endpoint: string, secret: string): Promise<number> {
    const { data } = await this.octokit.rest.repos.createWebhook({
      owner: repository.owner,
      repo: repository.repo,
      name: "web",
      active: true,
      events: [...GITHUB_AUTOMATION_EVENTS],
      config: { url: endpoint, content_type: "json", insecure_ssl: "0", secret },
    });
    return data.id;
  }

  async createIssue(repository: RepositoryRef | string, title: string, body: string): Promise<{ number: number; htmlUrl: string }> {
    const ref = typeof repository === "string" ? parseGitHubRepository(repository) : repository;
    const { data } = await this.octokit.rest.issues.create({ owner: ref.owner, repo: ref.repo, title, body });
    return { number: data.number, htmlUrl: data.html_url };
  }

  async ensureRepositoryFile(repository: RepositoryRef, path: string, content: string, message: string): Promise<{ created: boolean; branch: string }> {
    const { data: repositoryData } = await this.octokit.rest.repos.get({ owner: repository.owner, repo: repository.repo });
    const branch = repositoryData.default_branch;
    try {
      await this.octokit.rest.repos.getContent({ owner: repository.owner, repo: repository.repo, path, ref: branch });
      return { created: false, branch };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 404) throw error;
    }
    await this.octokit.rest.repos.createOrUpdateFileContents({
      owner: repository.owner,
      repo: repository.repo,
      path,
      branch,
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
    });
    return { created: true, branch };
  }

  async deleteWebhook(repository: RepositoryRef, hookId: number): Promise<void> {
    await this.octokit.rest.repos.deleteWebhook({ owner: repository.owner, repo: repository.repo, hook_id: hookId });
  }

  async deleteDiscordWebhooks(repository: RepositoryRef): Promise<number> {
    const { data: hooks } = await this.octokit.rest.repos.listWebhooks({ owner: repository.owner, repo: repository.repo, per_page: 100 });
    let deleted = 0;
    for (const hook of hooks) {
      const target = typeof hook.config.url === "string" ? hook.config.url : "";
      if (!target) continue;
      let url: URL;
      try { url = new URL(target); } catch { continue; }
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
