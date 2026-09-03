import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  Guild,
  ModalBuilder,
  ModalSubmitInteraction,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  findDailyScrumChannel,
  getDailyScrumRecord,
  listDailyScrumRecords,
  previousSeoulDateKey,
  saveDailyScrumRecord,
  type DailyScrumRecord,
} from "./daily-scrum.js";
import { findProject, type StoredProject } from "./projects.js";
import { seoulDateKey } from "./voice-time.js";

export type ProjectScrumAction = "write" | "carry" | "recent";

export function buildProjectScrumId(action: ProjectScrumAction, projectId: string): string {
  return `project_scrum:${action}:${projectId}`;
}

export function parseProjectScrumId(customId: string): {
  action: ProjectScrumAction;
  projectId: string;
} | null {
  const match = /^project_scrum:(write|carry|recent):([A-Za-z0-9_-]+)$/.exec(customId);
  return match
    ? { action: match[1] as ProjectScrumAction, projectId: match[2]! }
    : null;
}

export function scrumWriteDefaults(
  todayRecord: Pick<DailyScrumRecord, "todo" | "did"> | null,
  yesterdayRecord: Pick<DailyScrumRecord, "todo" | "did"> | null,
  carryYesterday: boolean,
): { todo: string; did: string } {
  return {
    todo: todayRecord?.todo ?? "",
    did: carryYesterday
      ? (yesterdayRecord?.todo.trim() || todayRecord?.did || "")
      : (todayRecord?.did ?? ""),
  };
}

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

function compactScrumItems(value: string): string {
  return splitScrumItems(value).join(", ") || "없음";
}

export function recentScrumText(records: DailyScrumRecord[]): string {
  if (records.length === 0) return "아직 작성한 데일리 스크럼 기록이 없습니다.";

  return records
    .map((record) => [
      `**${record.date}**`,
      record.did.trim() ? `✅ DID · ${compactScrumItems(record.did)}` : null,
      `🎯 TODO · ${compactScrumItems(record.todo)}`,
    ].filter((line): line is string => Boolean(line)).join("\n"))
    .join("\n\n")
    .slice(0, 1900);
}

export function scrumPanelMessage(project: StoredProject) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildProjectScrumId("write", project.id))
      .setLabel("오늘 작성/수정")
      .setEmoji("✍️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(buildProjectScrumId("carry", project.id))
      .setLabel("전날 TODO 완료 처리")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(buildProjectScrumId("recent", project.id))
      .setLabel("내 최근 기록")
      .setEmoji("📖")
      .setStyle(ButtonStyle.Secondary),
  );

  const embed = new EmbedBuilder()
    .setTitle("📋 데일리 스크럼")
    .setDescription([
      `**${project.name}** 프로젝트의 데일리 스크럼입니다.`,
      "버튼으로 오늘 기록을 작성하거나 수정할 수 있습니다.",
      "전날 TODO 완료 처리는 저장 전에 내용을 다시 확인합니다.",
    ].join("\n"));

  return {
    embeds: [embed],
    components: [row],
  };
}

export function scrumPinnedGuideMessage(project: StoredProject, hubUrl?: string) {
  const description = [
    `**${project.name}** 프로젝트의 데일리 스크럼 안내입니다.`,
    "고정된 메시지 목록은 빠르게 찾아가는 용도로만 사용합니다.",
    "실제 작성/수정은 **📌・프로젝트 → 스크럼**에서 진행해주세요.",
    hubUrl
      ? `[📌 프로젝트 허브로 이동](${hubUrl})`
      : "`📌・프로젝트` 채널에서 **스크럼** 버튼을 눌러주세요.",
  ].join("\n");

  return {
    embeds: [new EmbedBuilder().setTitle("📋 데일리 스크럼").setDescription(description)],
    components: [],
  };
}

async function resolveProjectHubUrl(channel: TextChannel, project: StoredProject): Promise<string | undefined> {
  const channels = await channel.guild.channels.fetch().catch(() => null);
  if (!channels) return undefined;

  const overview = channels.find((candidate) =>
    candidate instanceof TextChannel
    && candidate.parentId === project.categoryId
    && candidate.name === "📌・프로젝트",
  );
  if (!(overview instanceof TextChannel)) return undefined;

  const channelUrl = `https://discord.com/channels/${channel.guild.id}/${overview.id}`;
  return project.hubPanelMessageId
    ? `${channelUrl}/${project.hubPanelMessageId}`
    : channelUrl;
}

export async function ensureScrumPanel(
  channel: TextChannel,
  project: StoredProject,
): Promise<string> {
  const hubUrl = await resolveProjectHubUrl(channel, project);
  const pinnedGuide = scrumPinnedGuideMessage(project, hubUrl);

  if (project.scrumPanelMessageId) {
    const existing = await channel.messages.fetch(project.scrumPanelMessageId).catch(() => null);
    if (existing) {
      await existing.edit(pinnedGuide);
      if (!existing.pinned) await existing.pin().catch(() => undefined);
      return existing.id;
    }
  }

  const created = await channel.send(pinnedGuide);
  await created.pin().catch(() => undefined);
  return created.id;
}

async function resolveScrumChannel(guild: Guild, project: StoredProject): Promise<TextChannel | null> {
  if (project.scrumChannelId) {
    const stored = await guild.channels.fetch(project.scrumChannelId).catch(() => null);
    if (stored instanceof TextChannel) return stored;
  }
  return findDailyScrumChannel(guild, project);
}

function scrumInput(
  id: string,
  label: string,
  placeholder: string,
  value: string,
  required: boolean,
): ActionRowBuilder<TextInputBuilder> {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(required);
  if (value.trim()) input.setValue(value.slice(0, 4000));
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

async function showScrumWriteModal(
  interaction: ButtonInteraction,
  project: StoredProject,
  carryYesterday: boolean,
): Promise<void> {
  const now = new Date();
  const today = seoulDateKey(now);
  const yesterday = previousSeoulDateKey(now);
  const [todayRecord, yesterdayRecord] = await Promise.all([
    getDailyScrumRecord(project.id, interaction.user.id, today),
    getDailyScrumRecord(project.id, interaction.user.id, yesterday),
  ]);

  if (carryYesterday && !yesterdayRecord?.todo.trim()) {
    await interaction.reply({
      content: "전날 완료 처리할 TODO가 없습니다.",
      ephemeral: true,
    });
    return;
  }

  const defaults = scrumWriteDefaults(todayRecord, yesterdayRecord, carryYesterday);
  const modal = new ModalBuilder()
    .setCustomId(`project_scrum_write_modal:${project.id}`)
    .setTitle(carryYesterday ? "전날 TODO 완료 처리" : "오늘 데일리 스크럼");
  modal.addComponents(
    scrumInput("todo", "오늘 TODO", "쉼표 또는 줄바꿈으로 여러 개 입력", defaults.todo, true),
    scrumInput("did", "오늘 DID (선택)", "완료한 일", defaults.did, false),
  );
  await interaction.showModal(modal);
}

export async function handleProjectScrumButton(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseProjectScrumId(interaction.customId);
  if (!parsed) return false;

  const project = await findProject(parsed.projectId);
  if (!project || project.guildId !== interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "연결 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }

  const scrumChannel = await resolveScrumChannel(interaction.guild, project);
  if (!scrumChannel) {
    await interaction.reply({
      content: "스크럼 채널을 찾을 수 없습니다. 관리자에게 자동 복구를 요청해주세요.",
      ephemeral: true,
    });
    return true;
  }

  if (parsed.action === "recent") {
    const records = await listDailyScrumRecords(project.id, interaction.user.id, 5);
    await interaction.reply({
      content: `📖 **내 최근 데일리 스크럼**\n\n${recentScrumText(records)}`,
      ephemeral: true,
    });
    return true;
  }

  await showScrumWriteModal(interaction, project, parsed.action === "carry");
  return true;
}

export async function handleProjectScrumModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  const match = /^project_scrum_write_modal:([A-Za-z0-9_-]+)$/.exec(interaction.customId);
  if (!match) return false;

  const project = await findProject(match[1]!);
  if (!project || project.guildId !== interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "연결 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }

  const todo = interaction.fields.getTextInputValue("todo").trim();
  const did = interaction.fields.getTextInputValue("did").trim();
  if (!todo) {
    await interaction.reply({ content: "오늘 TODO를 한 개 이상 입력해주세요.", ephemeral: true });
    return true;
  }

  const scrumChannel = await resolveScrumChannel(interaction.guild, project);
  if (!scrumChannel) {
    await interaction.reply({
      content: "스크럼 채널을 찾을 수 없습니다. 관리자에게 자동 복구를 요청해주세요.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  const now = new Date();
  const today = seoulDateKey(now);
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
  let channelId = scrumChannel.id;
  let updatedExisting = false;

  if (existing?.messageId && existing.channelId === scrumChannel.id) {
    const previousMessage = await scrumChannel.messages.fetch(existing.messageId).catch(() => null);
    if (previousMessage) {
      await previousMessage.edit({ embeds: [embed] });
      messageId = previousMessage.id;
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
    updatedExisting
      ? `✅ 오늘 스크럼을 수정했습니다.\n<#${scrumChannel.id}>`
      : `✅ 오늘 스크럼을 기록했습니다.\n<#${scrumChannel.id}>`,
  );
  return true;
}
