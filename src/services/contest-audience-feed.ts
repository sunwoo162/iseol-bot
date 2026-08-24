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
  contestAudienceFilterLabel,
  contestVoteComponents,
  contestVoteEmbed,
  findContestFeed,
  getEligibleHumans,
  majorityOf,
  matchesContestAudience,
  type ContestAudienceFilter,
} from "./contest-feed.js";
import {
  createContestVoteId,
  listContestVotesForChannel,
  saveContestVote,
  updateContestVote,
} from "./contest-votes.js";
import { resolveContestDeadline, seoulDateKey } from "./contest-time.js";
import { listActiveItContests, type Contest } from "./contests.js";

const DATA_FILE = resolve(process.cwd(), "data", "contest-audience-feeds.json");
const POLL_INTERVAL_MS = 60 * 60 * 1000;

export type ContestAudienceFeedState = {
  guildId: string;
  categoryId: string;
  channelId: string;
  audienceFilter: ContestAudienceFilter;
  postedKeys: string[];
  createdAt: string;
  lastSyncedAt?: string;
};

async function readStates(): Promise<ContestAudienceFeedState[]> {
  try {
    return JSON.parse(await readFile(DATA_FILE, "utf8")) as ContestAudienceFeedState[];
  } catch {
    return [];
  }
}

async function writeStates(states: ContestAudienceFeedState[]): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(states, null, 2), "utf8");
}

async function saveState(state: ContestAudienceFeedState): Promise<void> {
  const states = await readStates();
  const index = states.findIndex((item) =>
    item.guildId === state.guildId && item.audienceFilter === state.audienceFilter,
  );
  if (index >= 0) states[index] = state;
  else states.push(state);
  await writeStates(states);
}

export async function findContestAudienceFeed(
  guildId: string,
  audienceFilter: ContestAudienceFilter,
): Promise<ContestAudienceFeedState | null> {
  const states = await readStates();
  return states.find((state) =>
    state.guildId === guildId && state.audienceFilter === audienceFilter,
  ) ?? null;
}

function channelName(filter: ContestAudienceFilter): string {
  if (filter === "high-school") return "🎓・고등학생-공모전";
  if (filter === "university") return "🎓・대학생-공모전";
  return "📢・전체-공모전";
}

async function ensureContestCategory(guild: Guild): Promise<string> {
  const baseFeed = await findContestFeed(guild.id);
  if (baseFeed) {
    const category = await guild.channels.fetch(baseFeed.categoryId).catch(() => null);
    if (category?.type === ChannelType.GuildCategory) return category.id;
  }

  const cached = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildCategory && channel.name === "🏆 공모전",
  );
  if (cached) return cached.id;

  const category = await guild.channels.create({
    name: "🏆 공모전",
    type: ChannelType.GuildCategory,
    reason: "참가대상별 IT 공모전 채널 생성",
  });
  return category.id;
}

export async function createContestAudienceFeed(
  guild: Guild,
  audienceFilter: ContestAudienceFilter,
): Promise<{ state: ContestAudienceFeedState; created: boolean }> {
  const existing = await findContestAudienceFeed(guild.id, audienceFilter);
  if (existing) {
    const channel = await guild.channels.fetch(existing.channelId).catch(() => null);
    if (channel instanceof TextChannel) return { state: existing, created: false };
  }

  const categoryId = await ensureContestCategory(guild);
  const label = contestAudienceFilterLabel(audienceFilter);
  const channel = await guild.channels.create({
    name: channelName(audienceFilter),
    type: ChannelType.GuildText,
    parent: categoryId,
    reason: `${label} 대상 IT 공모전 자동 게시 채널 생성`,
  });

  const state: ContestAudienceFeedState = {
    guildId: guild.id,
    categoryId,
    channelId: channel.id,
    audienceFilter,
    postedKeys: [],
    createdAt: new Date().toISOString(),
  };
  await saveState(state);

  await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle(`🏆 ${label} 대상 IT 공모전`)
      .setDescription(`이설이가 진행 중인 **웹/모바일/IT 공모전** 중 참가대상이 **${label}** 조건에 맞는 공모전만 이 채널에 올립니다.\n현재 공모전을 바로 가져오고 이후 **1시간마다** 새 공모전을 확인합니다. 과반수 투표가 모이면 기존 공모전 기능과 동일하게 준비 공간을 생성할 수 있습니다.`)],
  });

  return { state, created: true };
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/제\s*\d+\s*회/g, "")
    .replace(/[\[\](){}<>「」『』【】'"“”‘’·•,:.!?~_\-–—/\\|]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function contestKey(contest: Contest): string {
  return normalizeTitle(contest.title) || contest.url;
}

async function publishContest(channel: TextChannel, contest: Contest): Promise<void> {
  const eligibleHumans = await getEligibleHumans(channel);
  const eligibleVoterIds = [...eligibleHumans.keys()];
  const majority = majorityOf(eligibleVoterIds.length);
  const voteId = createContestVoteId();
  const contestLink = contest.homepage || contest.url;

  const message = await channel.send({
    embeds: [contestVoteEmbed(contest, 0, majority, false)],
    components: contestVoteComponents(voteId, contestLink, false),
  });

  await saveContestVote({
    id: voteId,
    guildId: channel.guild.id,
    channelId: channel.id,
    messageId: message.id,
    title: contest.title,
    url: contest.url,
    sources: contest.sources,
    field: contest.field,
    target: contest.target,
    host: contest.host,
    sponsor: contest.sponsor,
    period: contest.period,
    totalPrize: contest.totalPrize,
    firstPrize: contest.firstPrize,
    homepage: contest.homepage,
    attachments: contest.attachments,
    status: contest.status,
    eligibleVoterIds,
    majority,
    voterIds: [],
    finalized: false,
  });
}

async function refreshContestDeadlineCards(channel: TextChannel): Promise<void> {
  const today = seoulDateKey();
  const votes = await listContestVotesForChannel(channel.guild.id, channel.id);

  for (const vote of votes) {
    if (vote.deadlineLastRenderedDate === today) continue;

    const resolved = resolveContestDeadline(vote);
    if (!resolved.deadlineDate) continue;

    const message = await channel.messages.fetch(vote.messageId).catch(() => null);
    if (!message) continue;

    const majority = vote.majority ?? majorityOf(vote.eligibleVoterIds?.length ?? 0);
    await message.edit({
      embeds: [contestVoteEmbed(resolved, vote.voterIds.length, majority, vote.finalized)],
      components: contestVoteComponents(vote.id, vote.homepage || vote.url, vote.finalized),
    });

    await updateContestVote(vote.id, {
      deadlineDate: resolved.deadlineDate,
      deadlineLastRenderedDate: today,
    });
  }
}

export async function syncContestAudienceFeed(
  client: Client,
  state: ContestAudienceFeedState,
): Promise<number> {
  const guild = client.guilds.cache.get(state.guildId)
    ?? await client.guilds.fetch(state.guildId).catch(() => null);
  if (!guild) return 0;

  const fetched = await guild.channels.fetch(state.channelId).catch(() => null);
  if (!(fetched instanceof TextChannel)) return 0;

  await refreshContestDeadlineCards(fetched);

  const contests = await listActiveItContests();
  const posted = new Set(state.postedKeys);
  let count = 0;

  for (const contest of contests) {
    if (!matchesContestAudience(contest, state.audienceFilter)) continue;
    const key = contestKey(contest);
    if (posted.has(key)) continue;

    await publishContest(fetched, contest);
    posted.add(key);
    count += 1;

    state.postedKeys = [...posted];
    state.lastSyncedAt = new Date().toISOString();
    await saveState(state);
  }

  state.postedKeys = [...posted];
  state.lastSyncedAt = new Date().toISOString();
  await saveState(state);
  return count;
}

export async function syncAllContestAudienceFeeds(client: Client): Promise<void> {
  const states = await readStates();
  for (const state of states) {
    try {
      const added = await syncContestAudienceFeed(client, state);
      if (added > 0) {
        console.log(`새 ${contestAudienceFilterLabel(state.audienceFilter)} 대상 IT 공모전 게시 완료: ${added}개`);
      }
    } catch (error) {
      console.error(`참가대상별 공모전 자동 수집 실패 (${state.guildId}/${state.audienceFilter})`, error);
    }
  }
}

export function startContestAudienceFeedPolling(client: Client): void {
  void syncAllContestAudienceFeeds(client);
  setInterval(() => void syncAllContestAudienceFeeds(client), POLL_INTERVAL_MS);
  console.log("참가대상별 IT 공모전 자동 수집 시작: 1시간 간격");
}
