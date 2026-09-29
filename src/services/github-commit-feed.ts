import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { config } from "../config.js";
import type { RepositoryRef } from "./github.js";
import { startGitHubAutomationPolling } from "./github-automation-polling.js";
import { GitHubUserService, listGitHubAccounts, type GitHubRepositoryEvent } from "./github-user.js";
import { listProjects, type StoredProject } from "./projects.js";

const DATA_FILE = resolve(process.cwd(), "data", "github-commit-feed.json");
const POLL_INTERVAL_MS = 60_000;
const MAX_SEEN_EVENTS = 200;
const MAX_SEEN_COMMITS = 500;

type RepositorySide = "frontend" | "backend";

type CommitFeedState = {
  key: string;
  guildId: string;
  projectId: string;
  side: RepositorySide;
  seenEventIds: string[];
  seenCommitShas: string[];
  initializedAt: string;
};

async function readStates(): Promise<CommitFeedState[]> {
  try {
    return JSON.parse(await readFile(DATA_FILE, "utf8")) as CommitFeedState[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeStates(states: CommitFeedState[]): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(states, null, 2), "utf8");
}

function stateKey(project: StoredProject, side: RepositorySide): string {
  return `${project.id}:${side}`;
}

function projectRepository(project: StoredProject, side: RepositorySide): RepositoryRef {
  return side === "frontend" ? project.frontend : project.backend;
}

function projectLogChannelName(side: RepositorySide): string {
  return side === "frontend" ? "💻・frontend-log" : "🛠・backend-log";
}

async function getProjectLogChannel(
  client: Client,
  project: StoredProject,
  side: RepositorySide,
): Promise<TextChannel | null> {
  const guild = client.guilds.cache.get(project.guildId)
    ?? await client.guilds.fetch(project.guildId).catch(() => null);
  if (!guild) return null;

  const channels = await guild.channels.fetch();
  const expectedName = projectLogChannelName(side);
  const channel = channels.find((item) =>
    item instanceof TextChannel
    && item.parentId === project.categoryId
    && item.name === expectedName,
  );

  return channel instanceof TextChannel ? channel : null;
}

function branchName(event: GitHubRepositoryEvent): string {
  const ref = event.payload?.ref?.trim();
  if (!ref) return "알 수 없음";
  return ref.replace(/^refs\/heads\//, "");
}

async function publishLinkedPush(
  client: Client,
  project: StoredProject,
  side: RepositorySide,
  event: GitHubRepositoryEvent,
  seenCommitShas: Set<string>,
): Promise<void> {
  if (event.type !== "PushEvent") return;

  const actorLogin = event.actor?.login?.trim();
  if (!actorLogin) return;

  const links = await listGitHubAccounts(project.guildId);
  const link = links.find((item) => item.githubLogin.toLowerCase() === actorLogin.toLowerCase());
  if (!link) return;

  const commits = (event.payload?.commits ?? []).filter((commit) => !seenCommitShas.has(commit.sha));
  if (commits.length === 0) return;

  const channel = await getProjectLogChannel(client, project, side);
  if (!channel) {
    console.warn(`GitHub 연결 사용자 커밋 로그 채널을 찾지 못했습니다: ${project.name}/${side}`);
    return;
  }

  const repository = projectRepository(project, side);
  const branch = branchName(event);
  const timestamp = event.created_at ? new Date(event.created_at) : null;

  for (const commit of commits) {
    const title = commit.message.split("\n")[0]?.trim() || "커밋 메시지 없음";
    const commitUrl = `${repository.url}/commit/${commit.sha}`;
    const embed = new EmbedBuilder()
      .setTitle(`🟩 ${title.slice(0, 250)}`)
      .setURL(commitUrl)
      .setAuthor({
        name: `@${actorLogin}`,
        iconURL: `https://github.com/${encodeURIComponent(actorLogin)}.png?size=64`,
        url: `https://github.com/${encodeURIComponent(actorLogin)}`,
      })
      .addFields(
        { name: "프로젝트", value: project.name.slice(0, 1024), inline: true },
        { name: "저장소", value: `[${repository.owner}/${repository.repo}](${repository.url})`, inline: true },
        { name: "브랜치", value: `\`${branch.slice(0, 100)}\``, inline: true },
        { name: "커밋", value: `[\`${commit.sha.slice(0, 7)}\`](${commitUrl})`, inline: true },
        { name: "연결 사용자", value: `<@${link.discordUserId}>`, inline: true },
      );

    if (timestamp && !Number.isNaN(timestamp.getTime())) embed.setTimestamp(timestamp);

    await channel.send({
      content: `<@${link.discordUserId}> 새 커밋이 기록됐어요.`,
      allowedMentions: { users: [link.discordUserId] },
      embeds: [embed],
    });
    seenCommitShas.add(commit.sha);
  }
}

async function syncRepository(
  client: Client,
  github: GitHubUserService,
  project: StoredProject,
  side: RepositorySide,
  states: CommitFeedState[],
): Promise<void> {
  const repository = projectRepository(project, side);
  const events = await github.listRepositoryEvents(repository);
  const key = stateKey(project, side);
  let state = states.find((item) => item.key === key);

  if (!state) {
    state = {
      key,
      guildId: project.guildId,
      projectId: project.id,
      side,
      seenEventIds: events.map((event) => event.id).slice(0, MAX_SEEN_EVENTS),
      seenCommitShas: events
        .flatMap((event) => event.payload?.commits ?? [])
        .map((commit) => commit.sha)
        .slice(0, MAX_SEEN_COMMITS),
      initializedAt: new Date().toISOString(),
    };
    states.push(state);
    return;
  }

  const seenEventIds = new Set(state.seenEventIds);
  const seenCommitShas = new Set(state.seenCommitShas);
  const unseenEvents = events.filter((event) => !seenEventIds.has(event.id)).reverse();

  for (const event of unseenEvents) {
    await publishLinkedPush(client, project, side, event, seenCommitShas);
    seenEventIds.add(event.id);
  }

  state.seenEventIds = [...events.map((event) => event.id), ...seenEventIds].filter(
    (id, index, array) => array.indexOf(id) === index,
  ).slice(0, MAX_SEEN_EVENTS);
  state.seenCommitShas = [...seenCommitShas].slice(-MAX_SEEN_COMMITS);
}

export async function syncGitHubCommitFeeds(client: Client): Promise<void> {
  const github = new GitHubUserService(config.githubToken);
  const projects = await listProjects();
  const states = await readStates();
  const activeKeys = new Set(projects.flatMap((project) => [stateKey(project, "frontend"), stateKey(project, "backend")]));
  const nextStates = states.filter((state) => activeKeys.has(state.key));

  for (const project of projects) {
    for (const side of ["frontend", "backend"] as const) {
      try {
        await syncRepository(client, github, project, side, nextStates);
      } catch (error) {
        console.error(`GitHub 연결 사용자 커밋 확인 실패 (${project.name}/${side})`, error);
      }
    }
  }

  await writeStates(nextStates);
}

export function startGitHubCommitFeedPolling(client: Client): NodeJS.Timeout {
  startGitHubAutomationPolling(client);
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await syncGitHubCommitFeeds(client);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), POLL_INTERVAL_MS);
  console.log("GitHub 연결 사용자 커밋 감시 시작: 1분 간격");
  return timer;
}
