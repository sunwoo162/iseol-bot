import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  TextChannel,
} from "discord.js";
import {
  findDailyScrumChannel,
  getDailyScrumRecord,
  previousSeoulDateKey,
  saveDailyScrumRecord,
} from "../services/daily-scrum.js";
import { listProjects } from "../services/projects.js";
import { seoulDateKey } from "../services/voice-time.js";

export const scrumCommand = new SlashCommandBuilder()
  .setName("scrum")
  .setDescription("프로젝트 데일리 스크럼을 작성합니다.")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("write")
      .setDescription("오늘의 TODO와 DID를 기록합니다.")
      .addStringOption((option) =>
        option
          .setName("todo")
          .setDescription("오늘 할 일")
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(1000),
      )
      .addStringOption((option) =>
        option
          .setName("did")
          .setDescription("한 일 (비우면 전날 TODO가 자동으로 들어갑니다.)")
          .setRequired(false)
          .setMaxLength(1000),
      ),
  );

async function resolveProject(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild || !interaction.channel) return null;
  if (interaction.channel.type !== ChannelType.GuildText) return null;

  const parentId = interaction.channel.parentId;
  if (!parentId) return null;

  const projects = await listProjects();
  return projects.find((project) =>
    project.guildId === interaction.guild!.id
    && project.categoryId === parentId,
  ) ?? null;
}

export async function handleScrumCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand !== "write") return;

  await interaction.deferReply({ ephemeral: true });

  const project = await resolveProject(interaction);
  if (!project) {
    await interaction.editReply("❌ 이설로 생성한 프로젝트 카테고리 안에서 사용해주세요.");
    return;
  }

  const scrumChannel = await findDailyScrumChannel(interaction.guild, project);
  if (!(scrumChannel instanceof TextChannel)) {
    await interaction.editReply("❌ 이 프로젝트의 데일리 스크럼 채널을 찾을 수 없습니다.");
    return;
  }

  const now = new Date();
  const today = seoulDateKey(now);
  const yesterday = previousSeoulDateKey(now);
  const todo = interaction.options.getString("todo", true).trim();
  const didInput = interaction.options.getString("did")?.trim() ?? "";
  const yesterdayRecord = await getDailyScrumRecord(project.id, interaction.user.id, yesterday);
  const did = didInput || yesterdayRecord?.todo || "전날 TODO 없음";
  const existing = await getDailyScrumRecord(project.id, interaction.user.id, today);

  const embed = new EmbedBuilder()
    .setAuthor({
      name: interaction.user.globalName ?? interaction.user.username,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setTitle(`📋 ${today} 데일리 스크럼`)
    .addFields(
      { name: "✅ DID", value: did.slice(0, 1024) },
      { name: "🎯 TODO", value: todo.slice(0, 1024) },
    )
    .setFooter({ text: project.name })
    .setTimestamp(now);

  let messageId = existing?.messageId ?? "";
  let channelId = existing?.channelId ?? scrumChannel.id;
  let updatedExisting = false;

  if (existing?.messageId && existing.channelId === scrumChannel.id) {
    const previousMessage = await scrumChannel.messages.fetch(existing.messageId).catch(() => null);
    if (previousMessage) {
      await previousMessage.edit({ embeds: [embed] });
      messageId = previousMessage.id;
      channelId = scrumChannel.id;
      updatedExisting = true;
    }
  }

  if (!updatedExisting) {
    const message = await scrumChannel.send({ embeds: [embed] });
    messageId = message.id;
    channelId = scrumChannel.id;
  }

  await saveDailyScrumRecord({
    guildId: interaction.guild.id,
    projectId: project.id,
    userId: interaction.user.id,
    date: today,
    todo,
    did,
    channelId,
    messageId,
    updatedAt: now.toISOString(),
  });

  const didNote = didInput
    ? "입력한 DID를 사용했습니다."
    : yesterdayRecord
      ? "전날 TODO를 DID로 자동 반영했습니다."
      : "전날 TODO가 없어 DID는 `전날 TODO 없음`으로 기록했습니다.";

  await interaction.editReply(
    `${updatedExisting ? "✅ 오늘 스크럼을 수정했습니다." : "✅ 오늘 스크럼을 기록했습니다."}\n${didNote}\n<#${scrumChannel.id}>`,
  );
}
