import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type GitHubAutomationPollState = {
  repositories: Record<string, { milestones: Record<string, string> }>;
};

function repositoryStateKey(projectId: string, repository: string): string {
  return `${projectId}:${repository.toLowerCase()}`;
}

export class GitHubAutomationPollStateStore {
  constructor(private readonly file = resolve(process.cwd(), "data", "github-automation-polling.json")) {}

  private async read(): Promise<GitHubAutomationPollState> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as GitHubAutomationPollState;
      return parsed?.repositories ? parsed : { repositories: {} };
    } catch {
      return { repositories: {} };
    }
  }

  private async write(state: GitHubAutomationPollState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await rename(temp, this.file);
  }

  async getMilestones(projectId: string, repository: string): Promise<Record<string, string>> {
    const state = await this.read();
    return { ...(state.repositories[repositoryStateKey(projectId, repository)]?.milestones ?? {}) };
  }

  async setMilestones(projectId: string, repository: string, milestones: Record<string, string>): Promise<void> {
    const state = await this.read();
    state.repositories[repositoryStateKey(projectId, repository)] = { milestones };
    await this.write(state);
  }

  async retainRepositories(activeKeys: Set<string>): Promise<void> {
    const state = await this.read();
    let changed = false;
    for (const key of Object.keys(state.repositories)) {
      if (activeKeys.has(key)) continue;
      delete state.repositories[key];
      changed = true;
    }
    if (changed) await this.write(state);
  }

  static key(projectId: string, repository: string): string {
    return repositoryStateKey(projectId, repository);
  }
}
