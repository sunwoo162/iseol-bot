import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client, TextChannel } from "discord.js";
import {
  contestVoteComponents,
  contestVoteEmbed,
  getEligibleHumans,
  majorityOf,
  matchesContestAudience,
  type ContestAudienceFilter,
} from "./contest-feed.js";
import { createContestVoteId, saveContestVote } from "./contest-votes.js";
import { resolveContestDeadline, seoulDateKey } from "./contest-time.js";
import { listActiveItContests, type Contest } from "./contests.js";

const CONTEST_FEED_FILE = resolve(process.cwd(), "data", "contest-feed.json");
const CONTEST_AUDIENCE_FILE = resolve(process.cwd(), "data", "contest-audience-feeds.json");

type ContestFeedState = {
  guildId: string;
  channelId: string;
  audienceFilter?: ContestAudienceFilter;
};

type ContestAudienceFeedState = {
  guildId: string;
  channelId: string;
  audienceFilter: ContestAudienceFilter;
};

type RepostTarget = {
  channelId: string;
  audienceFilter: ContestAudienceFilter;
};

export type RepostAllResult = {
  channelCount: number;
  contestCount: number;
  postedCount: number;
};

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function listRepostTargets(guildId: string): Promise<RepostTarget[]> {
  const [feeds, audienceFeeds] = await Promise.all([
    readJson<ContestFeedState[]>(CONTEST_FEED_FILE, []),
    readJson<ContestAudienceFeedState[]>(CONTEST_AUDIENCE_FILE, []),
  ]);

  const targets = new Map<string, RepostTarget>();

  for (const state of feeds) {
    if (state.guildId !== guildId) continue;
    targets.set(state.channelId, {
      channelId: state.channelId,
      audienceFilter: state.audienceFilter ?? "all",
    });
  }

  for (const state of audienceFeeds) {
    if (state.guildId !== guildId) continue;
    targets.set(state.channelId, {
      channelId: state.channelId,
      audienceFilter: state.audienceFilter,
    });
  }

  return [...targets.values()];
}

async function publishContest(channel: TextChannel, contest: Contest, eligibleVoterIds: string[]): Promise<void> {
  const voteId = createContestVoteId();
  const majority = majorityOf(eligibleVoterIds.length);
  const contestLink = contest.homepage || contest.url;
  const createdAt = new Date().toISOString();
  const renderedDate = seoulDateKey();
  const contestWithDeadline = resolveContestDeadline({ ...contest, createdAt });

  const message = await channel.send({
    embeds: [contestVoteEmbed(contestWithDeadline, 0, majority, false)],
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
    deadlineDate: contestWithDeadline.deadlineDate,
    deadlineLastRenderedDate: renderedDate,
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

export async function repostAllContests(client: Client, guildId: string): Promise<RepostAllResult> {
  const guild = client.guilds.cache.get(guildId)
    ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) throw new Error("Discord 서버를 찾을 수 없습니다.");

  const targets = await listRepostTargets(guildId);
  if (targets.length === 0) {
    throw new Error("먼저 /contest setup 또는 /contest filter로 공모전 채널을 만들어주세요.");
  }

  const contests = await listActiveItContests();
  let channelCount = 0;
  let postedCount = 0;

  for (const target of targets) {
    const fetched = await guild.channels.fetch(target.channelId).catch(() => null);
    if (!(fetched instanceof TextChannel)) continue;

    const eligibleHumans = await getEligibleHumans(fetched);
    const eligibleVoterIds = [...eligibleHumans.keys()];
    const matching = contests.filter((contest) => matchesContestAudience(contest, target.audienceFilter));

    for (const contest of matching) {
      await publishContest(fetched, contest, eligibleVoterIds);
      postedCount += 1;
    }

    channelCount += 1;
  }

  if (channelCount === 0) {
    throw new Error("저장된 공모전 채널을 Discord에서 찾을 수 없습니다. /contest filter로 다시 만들어주세요.");
  }

  return {
    channelCount,
    contestCount: contests.length,
    postedCount,
  };
}
