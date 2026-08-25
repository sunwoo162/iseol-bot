import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ChannelType, type Guild } from "discord.js";
import { config } from "../config.js";
import { GitHubWebhookService, type RepositoryRef } from "./github.js";
import { clearMusicRuntime } from "./music.js";
import { leaveGuildVoiceChannel } from "./voice-connection.js";
import { stopStudySessionsForGuild } from "./voice-time.js";

const DATA_DIR = resolve(process.cwd(), "data");
const PROJECTS_FILE = resolve(DATA_DIR, "projects.json");
const CONTEST_FEED_FILE = resolve(DATA_DIR, "contest-feed.json");
const CONTEST_AUDIENCE_FILE = resolve(DATA_DIR, "contest-audience-feeds.json");
const CONTEST_VOTES_FILE = resolve(DATA_DIR, "contest-votes.json");
const JOB_FEED_FILE = resolve(DATA_DIR, "job-feed.json");
const MUSIC_FILE = resolve(DATA_DIR, "music-playlists.json");
const VOICE_TIME_FILE = resolve(DATA_DIR, "voice-study-time.json");
const DAILY_SCRUM_FILE = resolve(DATA_DIR, "daily-scrum.json");

type GuildScopedRecord = {
  guildId: string;
};

type ProjectRecord = GuildScopedRecord & {
  id?: string;
  categoryId: string;
  frontend?: RepositoryRef;
  backend?: RepositoryRef;
  frontendHookId?: number;
  backendHookId?: number;
  notionChannelId?: string;
  figmaChannelId?: string;
};

type FeedRecord = GuildScopedRecord & {
  categoryId: string;
  channelId: string;
};

type ContestVoteRecord = GuildScopedRecord & {
  channelId: string;
  prepCategoryId?: string;
};

type MusicData = {
  guilds?: Record<string, unknown>;
};

type VoiceStudyData = {
  dailySeconds?: Record<string, Record<string, number>>;
  activeSessions?: Array<{ guildId: string }>;
};

type DailyScrumData = {
  records?: Array<GuildScopedRecord & { projectId: string }>;
  reminderDates?: Record<string, string>;
};

export type GuildResetSummary = {
  deletedChannels: number;
  clearedRecords: number;
  removedExternalHooks: number;
  warnings: string[];
};

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

function recordsForGuild<T extends GuildScopedRecord>(records: T[], guildId: string): T[] {
  return records.filter((record) => record.guildId === guildId);
}

function withoutGuild<T extends GuildScopedRecord>(records: T[], guildId: string): T[] {
  return records.filter((record) => record.guildId !== guildId);
}

async function removeProjectHooks(projects: ProjectRecord[], warnings: string[]): Promise<number> {
  if (projects.length === 0) return 0;

  const github = new GitHubWebhookService(config.githubToken);
  let removed = 0;

  for (const project of projects) {
    if (project.frontend && project.frontendHookId) {
      try {
        await github.deleteWebhook(project.frontend, project.frontendHookId);
        removed += 1;
      } catch (error) {
        warnings.push(`Frontend GitHub webhook 삭제 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
      }
    }

    if (project.backend && project.backendHookId) {
      try {
        await github.deleteWebhook(project.backend, project.backendHookId);
        removed += 1;
      } catch (error) {
        warnings.push(`Backend GitHub webhook 삭제 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
      }
    }
  }

  return removed;
}

export async function resetGuildState(guild: Guild): Promise<GuildResetSummary> {
  await stopStudySessionsForGuild(guild.id);
  clearMusicRuntime(guild.id);
  leaveGuildVoiceChannel(guild.id);

  const [projects, contestFeeds, audienceFeeds, contestVotes, jobFeeds, musicData, voiceData, dailyScrumData] = await Promise.all([
    readJson<ProjectRecord[]>(PROJECTS_FILE, []),
    readJson<FeedRecord[]>(CONTEST_FEED_FILE, []),
    readJson<FeedRecord[]>(CONTEST_AUDIENCE_FILE, []),
    readJson<ContestVoteRecord[]>(CONTEST_VOTES_FILE, []),
    readJson<FeedRecord[]>(JOB_FEED_FILE, []),
    readJson<MusicData>(MUSIC_FILE, { guilds: {} }),
    readJson<VoiceStudyData>(VOICE_TIME_FILE, { dailySeconds: {}, activeSessions: [] }),
    readJson<DailyScrumData>(DAILY_SCRUM_FILE, { records: [], reminderDates: {} }),
  ]);

  const guildProjects = recordsForGuild(projects, guild.id);
  const guildContestFeeds = recordsForGuild(contestFeeds, guild.id);
  const guildAudienceFeeds = recordsForGuild(audienceFeeds, guild.id);
  const guildVotes = recordsForGuild(contestVotes, guild.id);
  const guildJobFeeds = recordsForGuild(jobFeeds, guild.id);

  const categoryIds = new Set<string>();
  const directChannelIds = new Set<string>();

  for (const project of guildProjects) {
    categoryIds.add(project.categoryId);
    if (project.notionChannelId) directChannelIds.add(project.notionChannelId);
    if (project.figmaChannelId) directChannelIds.add(project.figmaChannelId);
  }

  for (const feed of [...guildContestFeeds, ...guildAudienceFeeds, ...guildJobFeeds]) {
    categoryIds.add(feed.categoryId);
    directChannelIds.add(feed.channelId);
  }

  for (const vote of guildVotes) {
    directChannelIds.add(vote.channelId);
    if (vote.prepCategoryId) categoryIds.add(vote.prepCategoryId);
  }

  const warnings: string[] = [];
  const removedExternalHooks = await removeProjectHooks(guildProjects, warnings);
  const channels = await guild.channels.fetch();

  for (const channel of channels.values()) {
    if (channel?.parentId && categoryIds.has(channel.parentId)) {
      directChannelIds.add(channel.id);
    }
  }

  let deletedChannels = 0;
  for (const channelId of directChannelIds) {
    const channel = channels.get(channelId);
    if (!channel || channel.type === ChannelType.GuildCategory) continue;

    try {
      await channel.delete("이설 관리자 서버 초기화");
      deletedChannels += 1;
    } catch (error) {
      warnings.push(`채널 삭제 실패 (${channel.name}): ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
  }

  for (const categoryId of categoryIds) {
    const category = channels.get(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) continue;

    try {
      await category.delete("이설 관리자 서버 초기화");
      deletedChannels += 1;
    } catch (error) {
      warnings.push(`카테고리 삭제 실패 (${category.name}): ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
  }

  const nextMusicGuilds = { ...(musicData.guilds ?? {}) };
  const hadMusicData = Object.prototype.hasOwnProperty.call(nextMusicGuilds, guild.id);
  delete nextMusicGuilds[guild.id];

  const nextDailySeconds = { ...(voiceData.dailySeconds ?? {}) };
  let removedVoiceUsers = 0;
  for (const key of Object.keys(nextDailySeconds)) {
    if (!key.startsWith(`${guild.id}:`)) continue;
    delete nextDailySeconds[key];
    removedVoiceUsers += 1;
  }
  const activeSessions = voiceData.activeSessions ?? [];
  const removedActiveSessions = activeSessions.filter((session) => session.guildId === guild.id).length;

  const scrumRecords = dailyScrumData.records ?? [];
  const removedScrumRecords = scrumRecords.filter((record) => record.guildId === guild.id).length;
  const nextReminderDates = { ...(dailyScrumData.reminderDates ?? {}) };
  for (const project of guildProjects) {
    if (project.id) delete nextReminderDates[project.id];
  }

  await Promise.all([
    writeJson(PROJECTS_FILE, withoutGuild(projects, guild.id)),
    writeJson(CONTEST_FEED_FILE, withoutGuild(contestFeeds, guild.id)),
    writeJson(CONTEST_AUDIENCE_FILE, withoutGuild(audienceFeeds, guild.id)),
    writeJson(CONTEST_VOTES_FILE, withoutGuild(contestVotes, guild.id)),
    writeJson(JOB_FEED_FILE, withoutGuild(jobFeeds, guild.id)),
    writeJson(MUSIC_FILE, { ...musicData, guilds: nextMusicGuilds }),
    writeJson(VOICE_TIME_FILE, {
      ...voiceData,
      dailySeconds: nextDailySeconds,
      activeSessions: activeSessions.filter((session) => session.guildId !== guild.id),
    }),
    writeJson(DAILY_SCRUM_FILE, {
      records: scrumRecords.filter((record) => record.guildId !== guild.id),
      reminderDates: nextReminderDates,
    }),
  ]);

  const clearedRecords = guildProjects.length
    + guildContestFeeds.length
    + guildAudienceFeeds.length
    + guildVotes.length
    + guildJobFeeds.length
    + (hadMusicData ? 1 : 0)
    + removedVoiceUsers
    + removedActiveSessions
    + removedScrumRecords;

  return {
    deletedChannels,
    clearedRecords,
    removedExternalHooks,
    warnings,
  };
}
