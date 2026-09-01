import { Client, TextChannel } from "discord.js";
import { config } from "../config.js";
import { CalendarStateStore } from "./calendar/calendar-state.js";
import { GoogleCalendarService } from "./calendar/google-calendar.js";
import { GitHubAutomationPollStateStore } from "./github-automation-poll-state.js";
import { syncMilestonesFromPoll } from "./github-automation-polling-domain.js";
import { GitHubAutomationSource } from "./github-automation-source.js";
import { GitHubScheduleSyncService } from "./github-schedule-sync.js";
import { GitHubWebhookService, type RepositoryRef } from "./github.js";
import { listProjects, type StoredProject } from "./projects.js";
import { validateCiArtifactForPull } from "./review/github-ci-review.js";
import { GitHubReviewService } from "./review/github-review.js";
import { ensureProjectReviewWorkflows } from "./review/review-workflow-install.js";

const POLL_INTERVAL_MS = 60_000;
type RepositorySide = "frontend" | "backend";
const workflowInstallAttempted = new Set<string>();

function projectRepository(project: StoredProject, side: RepositorySide): RepositoryRef {
  return side === "frontend" ? project.frontend : project.backend;
}

function repositoryName(repository: RepositoryRef): string {
  return `${repository.owner}/${repository.repo}`;
}

async function getProjectLogChannel(client: Client, project: StoredProject, side: RepositorySide): Promise<TextChannel | null> {
  const storedId = side === "frontend" ? project.frontendLogChannelId : project.backendLogChannelId;
  if (storedId) {
    const stored = await client.channels.fetch(storedId).catch(() => null);
    if (stored instanceof TextChannel) return stored;
  }

  const guild = client.guilds.cache.get(project.guildId) ?? await client.guilds.fetch(project.guildId).catch(() => null);
  if (!guild) return null;
  const channels = await guild.channels.fetch();
  const expectedName = side === "frontend" ? "💻・frontend-log" : "🛠・backend-log";
  const channel = channels.find((item) => item instanceof TextChannel && item.parentId === project.categoryId && item.name === expectedName);
  return channel instanceof TextChannel ? channel : null;
}

async function notify(client: Client, project: StoredProject, side: RepositorySide, text: string): Promise<void> {
  const channel = await getProjectLogChannel(client, project, side);
  if (channel) await channel.send(text).catch(() => undefined);
}

async function ensureWorkflows(github: GitHubWebhookService, project: StoredProject): Promise<void> {
  if (workflowInstallAttempted.has(project.id)) return;
  workflowInstallAttempted.add(project.id);
  const results = await ensureProjectReviewWorkflows(github, project);
  for (const result of results) {
    if (result.error) console.warn(`Iseol review workflow 설치 실패 (${result.repository}): ${result.error}`);
    else if (result.created) console.log(`Iseol review workflow 생성: ${result.repository}`);
  }
}

async function syncPullRequests(
  client: Client,
  source: GitHubAutomationSource,
  reviewer: GitHubReviewService,
  project: StoredProject,
  side: RepositorySide,
): Promise<void> {
  const repository = projectRepository(project, side);
  const fullName = repositoryName(repository);
  const pulls = await source.listOpenPullRequests(repository);

  for (const pull of pulls) {
    try {
      const run = await source.findIseolReviewRun(repository, pull.headSha);
      if (run.state !== "completed") continue;
      const artifact = await source.downloadIseolReviewArtifact(repository, run.runId);
      if (!artifact) {
        console.warn(`Iseol review artifact 없음 (${fullName}#${pull.number}, run ${run.runId})`);
        continue;
      }
      validateCiArtifactForPull(artifact, fullName, pull.number, pull.headSha);
      const result = await reviewer.reviewCiArtifact(fullName, pull.number, pull.headSha, artifact);
      if (!result.skipped) {
        await notify(client, project, side, `🤖 PR #${pull.number} 이설 코드리뷰 완료 · inline ${result.findings}개`);
      }
    } catch (error) {
      console.error(`PR CI 코드리뷰 폴링 실패 (${fullName}#${pull.number})`, error);
      await notify(client, project, side, `❌ PR #${pull.number} 이설 코드리뷰 실패 · 서버 로그를 확인해주세요.`);
    }
  }
}

async function syncMilestones(
  source: GitHubAutomationSource,
  schedule: GitHubScheduleSyncService,
  pollState: GitHubAutomationPollStateStore,
  project: StoredProject,
  side: RepositorySide,
): Promise<void> {
  if (!project.calendarId) return;
  const repository = projectRepository(project, side);
  const fullName = repositoryName(repository);
  const milestones = await source.listMilestones(repository);
  const previous = await pollState.getMilestones(project.id, fullName);

  const next = await syncMilestonesFromPoll({
    milestones,
    previous,
    syncMilestone: (milestone) => schedule.syncMilestone(project.id, project.calendarId!, fullName, milestone),
  });

  await pollState.setMilestones(project.id, fullName, next);
}

export async function syncGitHubAutomationPolling(client: Client): Promise<void> {
  const calendarEnabled = Boolean(config.googleClientId && config.googleClientSecret && config.googleRefreshToken);
  const source = new GitHubAutomationSource(config.githubToken);
  const github = new GitHubWebhookService(config.githubToken);
  const reviewer = new GitHubReviewService(config.githubToken);
  const pollState = new GitHubAutomationPollStateStore();
  const schedule = calendarEnabled
    ? new GitHubScheduleSyncService(
        new GoogleCalendarService(config.googleClientId, config.googleClientSecret, config.googleRefreshToken, config.googleRedirectUri),
        new CalendarStateStore(),
      )
    : null;

  const projects = await listProjects();
  const activeKeys = new Set<string>();

  for (const project of projects) {
    try {
      await ensureWorkflows(github, project);
    } catch (error) {
      console.error(`Iseol review workflow 자동 설치 실패 (${project.name})`, error);
    }

    for (const side of ["frontend", "backend"] as const) {
      const repository = projectRepository(project, side);
      const fullName = repositoryName(repository);
      activeKeys.add(GitHubAutomationPollStateStore.key(project.id, fullName));

      try {
        await syncPullRequests(client, source, reviewer, project, side);
      } catch (error) {
        console.error(`PR 목록 폴링 실패 (${project.name}/${side})`, error);
      }

      if (schedule && project.calendarId) {
        try {
          await syncMilestones(source, schedule, pollState, project, side);
        } catch (error) {
          console.error(`GitHub milestone 폴링 실패 (${project.name}/${side})`, error);
        }
      }
    }
  }

  if (schedule) await pollState.retainRepositories(activeKeys);
}

export function startGitHubAutomationPolling(client: Client): NodeJS.Timeout {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await syncGitHubAutomationPolling(client);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), POLL_INTERVAL_MS);
  console.log("GitHub PR CI 코드리뷰/마일스톤 자동 감시 시작: 1분 간격");
  if (!config.googleClientId || !config.googleClientSecret || !config.googleRefreshToken) {
    console.log("GitHub milestone Calendar 동기화 대기: Google OAuth 미설정");
  }
  return timer;
}
