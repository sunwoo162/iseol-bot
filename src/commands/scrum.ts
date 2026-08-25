import {
  AutocompleteInteraction,
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
          .setDescription("오늘 할 일 (쉼표로 여러 개 구분)")
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(1000),
      )
      .addStringOption((option) =>
        option
          .setName("did")
          .setDescription("완료한 일 (선택, 전날 TODO에서 선택 가능)")
          .setRequired(false)
          .setAutocomplete(true)
          .setMaxLength(1000),
      ),
  );

function splitScrumItems(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatScrumItems(value: string): string {
  const items = splitScrumItems(value);
  if (items.length === 0) return value.trim();
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

async function resolveProject(
  interaction: ChatInputCommandInteraction | AutocompleteInteraction,
) {
  if (!interaction.guild || !(interaction.channel instanceof TextChannel)) return null;

  const parentId = interaction.channel.parentId;
  if (!parentId) return null;

  const projects = await listProjects();
  return projects.find((project) =>
    project.guildId === interaction.guild!.id
    && project.categoryId === parentId,
  ) ?? null;
}

export async function handleScrumAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild || interaction.commandName !== "scrum") return;

  let subcommand: string;
  try {
    subcommand = interaction.options.getSubcommand();
  } catch {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (subcommand !== "write" || focused.name !== "did") {
    await interaction.respond([]);
    return;
  }

  const project = await resolveProject(interaction);
  if (!project) {
    await interaction.respond([]);
    return;
  }

  const yesterday = previousSeoulDateKey();
  const yesterdayRecord = await getDailyScrumRecord(project.id, interaction.user.id, yesterday);
  const previousItems = splitScrumItems(yesterdayRecord?.todo ?? "");
  if (previousItems.length === 0) {
    await interaction.respond([]);
    return;
  }

  const rawFocused = String(focused.value ?? "");
  const parts = rawFocused.split(",");
  const query = (parts.pop() ?? "").trim().toLowerCase();
  const selected = parts.map((item) => item.trim()).filter(Boolean);
  const selectedLower = new Set(selected.map((item) => item.toLowerCase()));
  const prefix = selected.length > 0 ? `${selected.join(", ")}, ` : "";

  const choices: Array<{ name: string; value: string }> = [];
  const allValue = previousItems.join(", ");
  if (!rawFocused.trim() && allValue.length <= 100) {
    choices.push({ name: "✅ 전날 TODO 전체 선택", value: allValue });
  }

  for (const item of previousItems) {
    if (choices.length >= 25) break;
    if (selectedLower.has(item.toLowerCase())) continue;
    if (query && !item.toLowerCase().includes(query)) continue;

    const value = `${prefix}${item}`;
    if (value.length > 100) continue;

    choices.push({
      name: `${selected.length > 0 ? "+ " : ""}${item}`.slice(0, 100),
      value,
    });
  }

  await interaction.respond(choices.slice(0, 25));
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
  if (!scrumChannel) {
    await interaction.editReply("❌ 이 프로젝트의 데일리 스크럼 채널을 찾을 수 없습니다.");
    return;
  }

  const now = new Date();
  const today = seoulDateKey(now);
  const todo = interaction.options.getString("todo", true).trim();
  const did = interaction.options.getString("did")?.trim() ?? "";
  const existing = await getDailyScrumRecord(project.id, interaction.user.id, today);

  const embed = new EmbedBuilder()
    .setAuthor({
      name: interaction.user.globalName ?? interaction.user.username,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setTitle(`📋 ${today} 데일리 스크럼`)
    .setFooter({ text: project.name })
    .setTimestamp(now);

  if (did) {
    embed.addFields({
      name: "✅ DID",
      value: formatScrumItems(did).slice(0, 1024),
    });
  }

  embed.addFields({
    name: "🎯 TODO",
    value: formatScrumItems(todo).slice(0, 1024),
  });

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

  await interaction.editReply(
    `${updatedExisting ? "✅ 오늘 스크럼을 수정했습니다." : "✅ 오늘 스크럼을 기록했습니다."}\n<#${scrumChannel.id}>`,
  );
}
