import {
  ButtonInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  TextChannel,
} from "discord.js";
import {
  contestInfoEmbed,
  contestVoteComponents,
  contestVoteEmbed,
  createContestFeed,
  findContestFeed,
  getEligibleHumans,
  majorityOf,
  syncContestFeed,
} from "../services/contest-feed.js";
import {
  findContestVote,
  updateContestVote,
  type ContestVote,
} from "../services/contest-votes.js";

export const contestCommand = new SlashCommandBuilder()
  .setName("contest")
  .setDescription("IT 공모전 자동 수집 공간을 관리합니다.")
  .addSubcommand((subcommand) => subcommand
    .setName("setup")
    .setDescription("공모전 카테고리와 자동 수집 채널을 생성합니다."));

const processingVotes = new Set<string>();

function voterMentions(voterIds: string[]): string {
  if (voterIds.length === 0) return "아직 투표한 사람이 없습니다.";
  return voterIds.map((id) => `<@${id}>`).join(" ");
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
    const info = await source.guild.channels.create({
      name: "📋・공모전-정보",
      type: ChannelType.GuildText,
      parent: category.id,
    });
    createdChannelIds.push(info.id);

    const infoMessage = await info.send({ embeds: [contestInfoEmbed(vote)] });
    await infoMessage.pin();

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
      infoChannelId: info.id,
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
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
    return;
  }

  if (interaction.options.getSubcommand() !== "setup") return;

  await interaction.deferReply();

  try {
    const existing = await findContestFeed(interaction.guild.id);
    if (existing) {
      await interaction.editReply(`🏆 공모전 자동 수집 공간이 이미 설정되어 있습니다.\n<#${existing.channelId}>에서 새 공모전을 계속 확인합니다.`);
      return;
    }

    const state = await createContestFeed(interaction.guild);
    const added = await syncContestFeed(interaction.client, state);

    await interaction.editReply(`✅ 공모전 자동 수집 공간을 만들었습니다.\n<#${state.channelId}>에 현재 진행 중인 IT 공모전 **${added}개**를 게시했고, 이후 **1시간마다** 새 공모전을 확인합니다.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    await interaction.editReply(`❌ 공모전 자동 수집 설정에 실패했습니다.\n\`${message}\``);
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
        embeds: [contestVoteEmbed(vote, vote.voterIds.length, majority, true)],
        components: contestVoteComponents(vote.id, contestLink, true),
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
      embeds: [contestVoteEmbed(updated, voterIds.length, majority, reachedMajority)],
      components: contestVoteComponents(updated.id, updated.homepage || updated.url, reachedMajority),
    });

    await channel.send({
      content: `<@${interaction.user.id}> 님이 **${updated.title}** 공모전에 투표했습니다.`,
      allowedMentions: { users: [interaction.user.id] },
    });

    if (!reachedMajority || !prepRoom) return;

    await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle("✅ 공모전 참여 확정")
        .setDescription(`**${updated.title}** 공모전이 과반수 투표로 확정되었습니다.\n\n투표한 사람: ${voterMentions(voterIds)}\n투표 결과: **${voterIds.length}/${eligibleHumans.size}명**`)
        .addFields(
          { name: "공모전 정보", value: `<#${prepRoom.infoChannelId}>`, inline: true },
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
