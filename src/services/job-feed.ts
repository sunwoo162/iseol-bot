import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  ChannelType,
  Client,
  EmbedBuilder,
  Guild,
  TextChannel,
} from "discord.js";
import {
  JOB_FIELD_DEFINITIONS,
  JOB_FIELDS,
  getConfiguredJobSources,
  jobFieldLabel,
  listActiveDeveloperJobs,
  type JobField,
  type JobPosting,
} from "./jobs.js";

const DATA_FILE = resolve(process.cwd(), "data", "job-feed.json");
export const JOB_POLL_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_POST_LIMIT = 20;

export type JobFeedState = {
  guildId: string;
  categoryId: string;
  channelId: string;
  field: JobField;
  postedIds: string[];
  postedKeys?: string[];
  createdAt: string;
  lastSyncedAt?: string;
};

async function readStates(): Promise<JobFeedState[]> {
  try {
    return JSON.parse(await readFile(DATA_FILE, "utf8")) as JobFeedState[];
  } catch {
    return [];
  }
}

async function writeStates(states: JobFeedState[]): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(states, null, 2), "utf8");
}

async function saveState(state: JobFeedState): Promise<void> {
  const states = await readStates();
  const index = states.findIndex((item) => item.guildId === state.guildId && item.field === state.field);
  if (index >= 0) states[index] = state;
  else states.push(state);
  await writeStates(states);
}

export async function findJobFeed(guildId: string, field: JobField): Promise<JobFeedState | null> {
  const states = await readStates();
  return states.find((state) => state.guildId === guildId && state.field === field) ?? null;
}

async function findUsableCategory(guild: Guild): Promise<string | null> {
  const states = (await readStates()).filter((state) => state.guildId === guild.id);
  for (const state of states) {
    const channel = await guild.channels.fetch(state.categoryId).catch(() => null);
    if (channel?.type === ChannelType.GuildCategory) return channel.id;
  }
  return null;
}

async function ensureJobCategory(guild: Guild): Promise<string> {
  const existing = await findUsableCategory(guild);
  if (existing) return existing;

  const category = await guild.channels.create({
    name: "💼 개발・IT 취업 공고",
    type: ChannelType.GuildCategory,
    reason: "개발/IT 취업 공고 자동 수집 공간 생성",
  });
  return category.id;
}

export async function createJobFeed(guild: Guild, field: JobField): Promise<{ state: JobFeedState; created: boolean }> {
  const existing = await findJobFeed(guild.id, field);
  if (existing) {
    const channel = await guild.channels.fetch(existing.channelId).catch(() => null);
    if (channel instanceof TextChannel) return { state: existing, created: false };
  }

  const categoryId = await ensureJobCategory(guild);
  const definition = JOB_FIELD_DEFINITIONS[field];
  const channel = await guild.channels.create({
    name: definition.channelName,
    type: ChannelType.GuildText,
    parent: categoryId,
    reason: `${definition.label} 취업 공고 자동 게시 채널 생성`,
  });

  const state: JobFeedState = {
    guildId: guild.id,
    categoryId,
    channelId: channel.id,
    field,
    postedIds: [],
    postedKeys: [],
    createdAt: new Date().toISOString(),
  };
  await saveState(state);

  const sources = getConfiguredJobSources();
  const sourceText = sources.length > 0 ? sources.join(" + ") : "공식 채용정보 API";
  await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle(`💼 ${definition.label} 취업 공고`)
      .setDescription(`이설이가 **개발/IT 분야** 중 **${definition.label}** 관련 채용 공고만 주기적으로 확인합니다.\n**${sourceText}**에서 공식 API로 가져오며, 교육생 모집/국비 교육 과정은 제외합니다. 같은 회사의 같은 공고는 출처가 여러 개여도 한 번만 게시합니다.`)],
  });

  return { state, created: true };
}

function safe(value?: string, fallback = "정보없음"): string {
  return (value?.trim() || fallback).slice(0, 1024);
}

function jobEmbed(posting: JobPosting): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`💼 ${posting.title}`)
    .setURL(posting.url)
    .setDescription(`**${posting.company}**`)
    .addFields(
      { name: "전공분야", value: jobFieldLabel(posting.field), inline: true },
      { name: "근무/지원 조건", value: safe(posting.condition), inline: false },
      { name: "직무 태그", value: safe(posting.sector), inline: false },
      { name: "마감", value: safe(posting.deadline), inline: true },
      { name: "출처", value: posting.sources.join(" · "), inline: true },
    );
}

export async function syncJobFeed(client: Client, state: JobFeedState): Promise<number> {
  const guild = client.guilds.cache.get(state.guildId)
    ?? await client.guilds.fetch(state.guildId).catch(() => null);
  if (!guild) return 0;

  const fetched = await guild.channels.fetch(state.channelId).catch(() => null);
  if (!(fetched instanceof TextChannel)) return 0;

  const postings = await listActiveDeveloperJobs(state.field);
  const postedIds = new Set(state.postedIds);
  const postedKeys = new Set(state.postedKeys ?? []);
  const unseen = postings.filter((posting) =>
    !postedKeys.has(posting.id)
    && !posting.sourceIds.some((sourceId) => postedIds.has(sourceId)),
  );
  const toPublish = state.postedIds.length === 0 && postedKeys.size === 0
    ? unseen.slice(0, INITIAL_POST_LIMIT)
    : unseen;
  let count = 0;

  for (const posting of toPublish) {
    await fetched.send({ embeds: [jobEmbed(posting)] });
    postedKeys.add(posting.id);
    for (const sourceId of posting.sourceIds) postedIds.add(sourceId);
    count += 1;

    state.postedIds = [...postedIds];
    state.postedKeys = [...postedKeys];
    state.lastSyncedAt = new Date().toISOString();
    await saveState(state);
  }

  state.postedIds = [...postedIds];
  state.postedKeys = [...postedKeys];
  state.lastSyncedAt = new Date().toISOString();
  await saveState(state);
  return count;
}

export async function syncAllJobFeeds(client: Client): Promise<void> {
  const states = await readStates();
  for (const state of states) {
    try {
      const added = await syncJobFeed(client, state);
      if (added > 0) console.log(`새 ${jobFieldLabel(state.field)} 취업 공고 게시 완료: ${added}개`);
    } catch (error) {
      console.error(`취업 공고 자동 수집 실패 (${state.guildId}/${state.field})`, error);
    }
  }
}

export function startJobFeedPolling(client: Client): void {
  void syncAllJobFeeds(client);
  setInterval(() => void syncAllJobFeeds(client), JOB_POLL_INTERVAL_MS);
  const sources = getConfiguredJobSources();
  console.log(`개발/IT 취업 공고 자동 수집 시작: 1시간 간격${sources.length > 0 ? ` (${sources.join(" + ")})` : " (API 키 미설정)"}`);
}

export async function createAllJobFeeds(guild: Guild): Promise<Array<{ state: JobFeedState; created: boolean }>> {
  const results = [];
  for (const field of JOB_FIELDS) {
    results.push(await createJobFeed(guild, field));
  }
  return results;
}
