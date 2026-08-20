import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Guild,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";
import { createContestVoteId, saveContestVote } from "./contest-votes.js";
import { listActiveItContests, type Contest, type ContestAttachment } from "./contests.js";

const DATA_FILE = resolve(process.cwd(), "data", "contest-feed.json");
export const CONTEST_POLL_INTERVAL_MS = 60 * 60 * 1000;

export type ContestFeedState = {
  guildId: string;
  categoryId: string;
  channelId: string;
  postedKeys: string[];
  createdAt: string;
  lastSyncedAt?: string;
};

export type ContestCardData = {
  title: string;
  url: string;
  sources?: string[];
  field?: string;
  target?: string;
  host?: string;
  sponsor?: string;
  period?: string;
  totalPrize?: string;
  firstPrize?: string;
  homepage?: string;
  attachments?: ContestAttachment[];
  status?: string;
};

async function readStates(): Promise<ContestFeedState[]> {
  try {
    return JSON.parse(await readFile(DATA_FILE, "utf8")) as ContestFeedState[];
  } catch {
    return [];
  }
}

async function writeStates(states: ContestFeedState[]): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(states, null, 2), "utf8");
}

export async function findContestFeed(guildId: string): Promise<ContestFeedState | null> {
  const states = await readStates();
  return states.find((state) => state.guildId === guildId) ?? null;
}

async function saveContestFeed(state: ContestFeedState): Promise<void> {
  const states = await readStates();
  const index = states.findIndex((item) => item.guildId === state.guildId);
  if (index >= 0) states[index] = state;
  else states.push(state);
  await writeStates(states);
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

function contestKey(contest: ContestCardData): string {
  return normalizeTitle(contest.title) || contest.url;
}

export function majorityOf(total: number): number {
  return Math.floor(total / 2) + 1;
}

export async function getEligibleHumans(channel: TextChannel) {
  const members = await channel.guild.members.fetch();
  return members.filter((member) =>
    !member.user.bot
    && channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) === true,
  );
}

function safeValue(value?: string, fallback = "정보없음"): string {
  const text = value?.trim() || fallback;
  return text.slice(0, 1024);
}

function homepageValue(contest: ContestCardData): string {
  const url = contest.homepage || contest.url;
  return `[바로가기](${url})`;
}

function attachmentValue(attachments?: ContestAttachment[]): string {
  if (!attachments || attachments.length === 0) return "파일없음";

  return attachments
    .slice(0, 5)
    .map((attachment) => attachment.url
      ? `[${attachment.name.slice(0, 80)}](${attachment.url})`
      : attachment.name.slice(0, 100))
    .join("\n")
    .slice(0, 1024);
}

export function contestInfoEmbed(contest: ContestCardData): EmbedBuilder {
  const sources = contest.sources?.length ? contest.sources.join(" · ") : "출처 확인 필요";
  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${contest.title}`)
    .setURL(contest.homepage || contest.url)
    .setDescription("확정된 공모전의 상세 정보입니다.")
    .addFields(
      { name: "분야", value: safeValue(contest.field, "웹/모바일/IT"), inline: true },
      { name: "응모대상", value: safeValue(contest.target), inline: true },
      { name: "주최/주관", value: safeValue(contest.host), inline: false },
      { name: "후원/협찬", value: safeValue(contest.sponsor, "없음"), inline: false },
      { name: "접수기간", value: safeValue(contest.period), inline: false },
      { name: "총 상금", value: safeValue(contest.totalPrize), inline: true },
      { name: "1등 상금", value: safeValue(contest.firstPrize), inline: true },
      { name: "홈페이지", value: homepageValue(contest), inline: false },
      { name: "첨부파일", value: attachmentValue(contest.attachments), inline: false },
      { name: "출처", value: sources.slice(0, 1024), inline: false },
    );

  if (contest.status?.trim()) {
    embed.addFields({ name: "상태", value: contest.status.trim().slice(0, 1024), inline: true });
  }

  return embed;
}

export function contestVoteEmbed(
  contest: ContestCardData,
  voteCount: number,
  majority: number,
  finalized: boolean,
): EmbedBuilder {
  const embed = contestInfoEmbed(contest)
    .setTitle(`${finalized ? "✅ " : "🏆 "}${contest.title}`)
    .setDescription(finalized ? "과반수 투표로 준비가 확정된 공모전입니다." : "참여하고 싶은 사람은 아래 **투표** 버튼을 눌러주세요.");

  embed.addFields({ name: "투표", value: `${voteCount} / ${majority}명 이상`, inline: true });
  return embed;
}

export function contestVoteComponents(voteId: string, contestUrl: string, finalized: boolean) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`contest_vote:${voteId}`)
        .setLabel(finalized ? "참여 확정" : "투표")
        .setEmoji(finalized ? "✅" : "🗳️")
        .setStyle(finalized ? ButtonStyle.Success : ButtonStyle.Primary)
        .setDisabled(finalized),
      new ButtonBuilder()
        .setLabel("공모전 보기")
        .setStyle(ButtonStyle.Link)
        .setURL(contestUrl),
    ),
  ];
}

export async function createContestFeed(guild: Guild): Promise<ContestFeedState> {
  const existing = await findContestFeed(guild.id);
  if (existing) return existing;

  const category = await guild.channels.create({
    name: "🏆 공모전",
    type: ChannelType.GuildCategory,
    reason: "IT 공모전 자동 수집 공간 생성",
  });

  try {
    const channel = await guild.channels.create({
      name: "📢・공모전",
      type: ChannelType.GuildText,
      parent: category.id,
      reason: "IT 공모전 자동 게시 채널 생성",
    });

    const state: ContestFeedState = {
      guildId: guild.id,
      categoryId: category.id,
      channelId: channel.id,
      postedKeys: [],
      createdAt: new Date().toISOString(),
    };
    await saveContestFeed(state);

    await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle("🏆 IT 공모전 자동 수집")
        .setDescription("이설이가 여러 공모전 사이트를 주기적으로 확인하고, 새 웹/모바일/IT 공모전만 이 채널에 올립니다.\n\n같은 공모전은 중복 제거하며 과반수 투표가 모이면 별도 준비 공간을 자동으로 생성합니다.")],
    });

    return state;
  } catch (error) {
    await category.delete("공모전 피드 생성 실패 롤백").catch(() => undefined);
    throw error;
  }
}

async function publishContest(channel: TextChannel, contest: Contest, majority: number) {
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
    voterIds: [],
    finalized: false,
  });
}

export async function syncContestFeed(client: Client, state: ContestFeedState): Promise<number> {
  const guild = client.guilds.cache.get(state.guildId)
    ?? await client.guilds.fetch(state.guildId).catch(() => null);
  if (!guild) return 0;

  const fetched = await guild.channels.fetch(state.channelId).catch(() => null);
  if (!(fetched instanceof TextChannel)) return 0;

  const [contests, eligibleHumans] = await Promise.all([
    listActiveItContests(),
    getEligibleHumans(fetched),
  ]);
  const majority = majorityOf(eligibleHumans.size);
  const posted = new Set(state.postedKeys);
  let count = 0;

  for (const contest of contests) {
    const key = contestKey(contest);
    if (posted.has(key)) continue;

    await publishContest(fetched, contest, majority);
    posted.add(key);
    count += 1;

    state.postedKeys = [...posted];
    state.lastSyncedAt = new Date().toISOString();
    await saveContestFeed(state);
  }

  state.lastSyncedAt = new Date().toISOString();
  await saveContestFeed(state);
  return count;
}

export async function syncAllContestFeeds(client: Client): Promise<void> {
  const states = await readStates();
  for (const state of states) {
    try {
      const added = await syncContestFeed(client, state);
      if (added > 0) console.log(`새 IT 공모전 게시 완료: ${added}개`);
    } catch (error) {
      console.error(`공모전 자동 수집 실패 (${state.guildId})`, error);
    }
  }
}

export function startContestFeedPolling(client: Client): void {
  void syncAllContestFeeds(client);
  setInterval(() => void syncAllContestFeeds(client), CONTEST_POLL_INTERVAL_MS);
  console.log("IT 공모전 자동 수집 시작: 1시간 간격");
}
