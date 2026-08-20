import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
} from "discord.js";
import {
  createContestVoteId,
  findContestVote,
  saveContestVote,
  updateContestVote,
  type ContestVote,
} from "../services/contest-votes.js";
import { listActiveItContests, type Contest, type ContestAttachment } from "../services/contests.js";

export const contestCommand = new SlashCommandBuilder()
  .setName("contest")
  .setDescription("여러 공모전 사이트의 진행 중 IT 공모전을 모아 투표를 시작합니다.");

const processingVotes = new Set<string>();

type ContestCardData = {
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

function majorityOf(total: number): number {
  return Math.floor(total / 2) + 1;
}

function voterMentions(voterIds: string[]): string {
  if (voterIds.length === 0) return "아직 투표한 사람이 없습니다.";
  return voterIds.map((id) => `<@${id}>`).join(" ");
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

function contestEmbed(
  contest: ContestCardData,
  voterIds: string[],
  majority: number,
  finalized: boolean,
): EmbedBuilder {
  const sources = contest.sources?.length ? contest.sources.join(" · ") : "출처 확인 필요";
  const embed = new EmbedBuilder()
    .setTitle(`${finalized ? "✅ " : "🏆 "}${contest.title}`)
    .setURL(contest.homepage || contest.url)
    .setDescription(finalized ? "과반수 투표로 준비가 확정된 공모전입니다." : "참여하고 싶은 사람은 아래 **투표** 버튼을 눌러주세요.")
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
      { name: "투표", value: `${voterIds.length} / ${majority}명 이상`, inline: true },
      { name: "투표한 사람", value: voterMentions(voterIds), inline: false },
    );

  if (contest.status?.trim()) {
    embed.addFields({ name: "상태", value: contest.status.trim().slice(0, 1024), inline: true });
  }

  return embed;
}

function voteComponents(voteId: string, contestUrl: string, finalized: boolean) {
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

async function getEligibleHumans(channel: TextChannel) {
  const members = await channel.guild.members.fetch();
  return members.filter((member) =>
    !member.user.bot
    && channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) === true,
  );
}

function prepCategoryName(title: string): string {
  const clean = title.replace(/\s+/g, " ").trim();
  return `🏆 ${clean} 준비`.slice(0, 100);
}

async function createPrepRoom(source: TextChannel, vote: ContestVote) {
  const permissionOverwrites = source.permissionOverwrites.cache.map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield,
    deny: overwrite.deny.bitfield,
  }));

  const category = await source.guild.channels.create({
    name: prepCategoryName(vote.title),
    type: ChannelType.GuildCategory,
    permissionOverwrites,
  });
  const createdChannelIds: string[] = [];

  try {
    const idea = await source.guild.channels.create({
      name: "💡・아이디어",
      type: ChannelType.GuildText,
      parent: category.id,
    });
    createdChannelIds.push(idea.id);

    const discussion = await source.guild.channels.create({
      name: "💬・토론",
      type: ChannelType.GuildText,
      parent: category.id,
    });
    createdChannelIds.push(discussion.id);

    const personal = await source.guild.channels.create({
      name: "🔒・개인정보",
      type: ChannelType.GuildText,
      parent: category.id,
    });
    createdChannelIds.push(personal.id);

    return {
      categoryId: category.id,
      ideaChannelId: idea.id,
      discussionChannelId: discussion.id,
      personalChannelId: personal.id,
    };
  } catch (error) {
    for (const channelId of createdChannelIds.reverse()) {
      await source.guild.channels.delete(channelId, "공모전 준비방 생성 실패 롤백").catch(() => undefined);
    }
    await category.delete("공모전 준비방 생성 실패 롤백").catch(() => undefined);
    throw error;
  }
}

export async function handleContestCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.channel;
  if (!interaction.inGuild() || !interaction.guild || !(channel instanceof TextChannel)) {
    await interaction.reply({ content: "서버의 텍스트 채널에서만 사용할 수 있습니다.", ephemeral: true });
    return;
  }

  await interaction.deferReply();

  try {
    const [contests, eligibleHumans] = await Promise.all([
      listActiveItContests(),
      getEligibleHumans(channel),
    ]);

    if (contests.length === 0) {
      await interaction.editReply("현재 불러올 수 있는 진행 중 IT 공모전이 없습니다.");
      return;
    }

    const majority = majorityOf(eligibleHumans.size);
    const sourceNames = [...new Set(contests.flatMap((contest) => contest.sources))].join(" · ");
    await interaction.editReply(`🏆 **${sourceNames}**에서 진행 중인 IT 공모전을 모았습니다.\n중복 제거 후 **${contests.length}개**입니다.\n이 채널을 볼 수 있는 사람 중 봇을 제외한 **${eligibleHumans.size}명** 기준으로 **${majority}명** 이상 투표하면 참여가 확정됩니다.`);

    for (const contest of contests) {
      const voteId = createContestVoteId();
      const contestLink = contest.homepage || contest.url;
      const message = await channel.send({
        embeds: [contestEmbed(contest, [], majority, false)],
        components: voteComponents(voteId, contestLink, false),
      });

      await saveContestVote({
        id: voteId,
        guildId: interaction.guild.id,
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    await interaction.editReply(`❌ IT 공모전 목록을 불러오지 못했습니다.\n\`${message}\``);
  }
}

export async function handleContestVoteButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.customId.startsWith("contest_vote:")) return;

  const voteId = interaction.customId.split(":")[1];
  if (!voteId) return;

  if (processingVotes.has(voteId)) {
    await interaction.reply({ content: "다른 투표를 처리 중입니다. 잠시 후 다시 눌러주세요.", ephemeral: true });
    return;
  }

  processingVotes.add(voteId);
  await interaction.deferUpdate();

  try {
    const vote = await findContestVote(voteId);
    if (!vote || !interaction.guild || interaction.guildId !== vote.guildId) {
      await interaction.followUp({ content: "투표 정보를 찾을 수 없습니다.", ephemeral: true });
      return;
    }

    const channel = await interaction.guild.channels.fetch(vote.channelId).catch(() => null);
    if (!(channel instanceof TextChannel)) {
      await interaction.followUp({ content: "투표가 진행된 채널을 찾을 수 없습니다.", ephemeral: true });
      return;
    }

    const eligibleHumans = await getEligibleHumans(channel);
    const majority = majorityOf(eligibleHumans.size);
    const contestLink = vote.homepage || vote.url;

    if (!eligibleHumans.has(interaction.user.id)) {
      await interaction.followUp({ content: "이 투표의 참여 대상이 아닙니다.", ephemeral: true });
      return;
    }

    if (vote.finalized) {
      await interaction.message.edit({
        embeds: [contestEmbed(vote, vote.voterIds, majority, true)],
        components: voteComponents(vote.id, contestLink, true),
      });
      await interaction.followUp({ content: "이미 참여가 확정된 공모전입니다.", ephemeral: true });
      return;
    }

    if (vote.voterIds.includes(interaction.user.id)) {
      await interaction.followUp({
        content: `이미 투표했습니다. 현재 **${vote.voterIds.length}/${majority}명**이 투표했습니다.`,
        ephemeral: true,
      });
      return;
    }

    const voterIds = [...vote.voterIds, interaction.user.id];
    const reachedMajority = voterIds.length >= majority;
    let prepRoom: Awaited<ReturnType<typeof createPrepRoom>> | null = null;

    if (reachedMajority) {
      prepRoom = await createPrepRoom(channel, { ...vote, voterIds });
    }

    const updated = await updateContestVote(vote.id, {
      voterIds,
      finalized: reachedMajority,
      prepCategoryId: prepRoom?.categoryId,
    });
    if (!updated) throw new Error("투표 상태를 저장하지 못했습니다.");

    await interaction.message.edit({
      embeds: [contestEmbed(updated, voterIds, majority, reachedMajority)],
      components: voteComponents(updated.id, updated.homepage || updated.url, reachedMajority),
    });

    if (!reachedMajority) {
      await channel.send({
        embeds: [new EmbedBuilder()
          .setTitle("🗳️ 공모전 투표 현황")
          .setDescription(`**${updated.title}**\n\n투표한 사람: ${voterMentions(voterIds)}\n현재 **${voterIds.length}/${majority}명**`)
          .setURL(updated.homepage || updated.url)],
      });
      return;
    }

    if (!prepRoom) return;

    await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle("✅ 공모전 참여 확정")
        .setDescription(`**${updated.title}** 공모전이 과반수 투표로 확정되었습니다.\n\n투표한 사람: ${voterMentions(voterIds)}\n투표 결과: **${voterIds.length}/${eligibleHumans.size}명**`)
        .addFields(
          { name: "아이디어", value: `<#${prepRoom.ideaChannelId}>`, inline: true },
          { name: "토론", value: `<#${prepRoom.discussionChannelId}>`, inline: true },
          { name: "개인정보", value: `<#${prepRoom.personalChannelId}>`, inline: true },
        )
        .setURL(updated.homepage || updated.url)],
    });
  } catch (error) {
    console.error(`공모전 투표 처리 실패 (${voteId})`, error);
    const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    await interaction.followUp({ content: `❌ 투표 처리에 실패했습니다.\n\`${message}\``, ephemeral: true }).catch(() => undefined);
  } finally {
    processingVotes.delete(voteId);
  }
}
