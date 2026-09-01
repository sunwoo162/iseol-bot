import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";
import { calendarPanel } from "../calendar/calendar-discord.js";
import { scrumPanelMessage } from "../daily-scrum-discord.js";
import { githubAccountPanel } from "../github-account-discord.js";
import { findGitHubAccount } from "../github-user.js";
import { findProject, type StoredProject } from "../projects.js";
import { projectAdminPanel } from "./project-admin.js";
import {
  buildProjectHubId,
  parseProjectHubId,
  type ProjectHubAction,
} from "./project-custom-id.js";
import { projectHealthLines, storedProjectHealth, type ProjectHealth } from "./project-health.js";

function linkButton(label: string, url: string, emoji?: string): ButtonBuilder {
  const button = new ButtonBuilder()
    .setLabel(label)
    .setStyle(ButtonStyle.Link)
    .setURL(url);
  if (emoji) button.setEmoji(emoji);
  return button;
}

export function projectHubActionCopy(action: ProjectHubAction): string {
  if (action === "calendar") return "📅 일정 관리";
  if (action === "scrum") return "📋 데일리 스크럼";
  if (action === "github") return "🐙 GitHub 계정/프로젝트";
  if (action === "review") return "🔍 코드리뷰 상태";
  if (action === "refresh") return "🔄 프로젝트 상태 새로고침";
  return "⚙️ 프로젝트 관리";
}

export function projectHubMessage(project: StoredProject, health: ProjectHealth) {
  const memberRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildProjectHubId("calendar", project.id))
      .setLabel("일정")
      .setEmoji("📅")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(buildProjectHubId("scrum", project.id))
      .setLabel("스크럼")
      .setEmoji("📋")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildProjectHubId("github", project.id))
      .setLabel("GitHub")
      .setEmoji("🐙")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildProjectHubId("review", project.id))
      .setLabel("리뷰 상태")
      .setEmoji("🔍")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildProjectHubId("refresh", project.id))
      .setLabel("새로고침")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
  );

  const embed = new EmbedBuilder()
    .setTitle(`📌 ${project.name}`)
    .setDescription("이 프로젝트의 일정, 스크럼, GitHub, 코드리뷰 상태를 여기서 관리합니다.")
    .addFields({
      name: "연동 상태",
      value: projectHealthLines(health).join("\n"),
    });

  const links = [
    project.notionUrl ? linkButton("Notion", project.notionUrl, "📄") : null,
    project.figmaUrl ? linkButton("Figma", project.figmaUrl, "🎨") : null,
    linkButton("Frontend", project.frontend.url, "🐙"),
    linkButton("Backend", project.backend.url, "🐙"),
  ].filter((button): button is ButtonBuilder => Boolean(button));

  const manageButton = new ButtonBuilder()
    .setCustomId(buildProjectHubId("admin", project.id))
    .setLabel("관리")
    .setEmoji("⚙️")
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [embed],
    components: [
      memberRow,
      new ActionRowBuilder<ButtonBuilder>().addComponents(...links, manageButton),
    ],
  };
}

export async function ensureProjectHub(
  channel: TextChannel,
  project: StoredProject,
  health: ProjectHealth,
): Promise<string> {
  if (project.hubPanelMessageId) {
    const existing = await channel.messages.fetch(project.hubPanelMessageId).catch(() => null);
    if (existing) {
      await existing.edit(projectHubMessage(project, health));
      if (!existing.pinned) await existing.pin().catch(() => undefined);
      return existing.id;
    }
  }

  const created = await channel.send(projectHubMessage(project, health));
  await created.pin().catch(() => undefined);
  return created.id;
}

async function refreshHub(interaction: ButtonInteraction, project: StoredProject): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "연결 정보를 찾을 수 없습니다.", ephemeral: true });
    return;
  }

  const channels = await guild.channels.fetch();
  const overview = channels.find((channel) =>
    channel instanceof TextChannel
    && channel.parentId === project.categoryId
    && channel.name === "📌・프로젝트",
  );
  if (!(overview instanceof TextChannel)) {
    await interaction.reply({
      content: "프로젝트 허브 채널을 찾을 수 없습니다. 관리자에게 자동 복구를 요청해주세요.",
      ephemeral: true,
    });
    return;
  }

  await ensureProjectHub(overview, project, storedProjectHealth(project));
  await interaction.reply({ content: "✅ 프로젝트 상태를 새로고침했습니다.", ephemeral: true });
}

export async function handleProjectHubButton(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseProjectHubId(interaction.customId);
  if (!parsed) return false;

  const project = await findProject(parsed.projectId);
  if (!project || project.guildId !== interaction.guildId) {
    await interaction.reply({ content: "연결 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }

  if (parsed.action === "calendar") {
    await interaction.reply({
      ...calendarPanel(project.id, project.calendarUrl),
      ephemeral: true,
    });
    return true;
  }

  if (parsed.action === "scrum") {
    await interaction.reply({
      ...scrumPanelMessage(project),
      ephemeral: true,
    });
    return true;
  }

  if (parsed.action === "github") {
    const link = interaction.guildId
      ? await findGitHubAccount(interaction.guildId, interaction.user.id)
      : null;
    await interaction.reply(githubAccountPanel(project, link));
    return true;
  }

  if (parsed.action === "review") {
    await interaction.reply({
      content: [
        "🔍 **이설 Code Review**",
        `Frontend · ${project.frontend.owner}/${project.frontend.repo}`,
        `Backend · ${project.backend.owner}/${project.backend.repo}`,
        "PR이 생성되거나 새 커밋이 올라오면 자동 리뷰합니다.",
        "workflow 설치 권한이 부족하면 관리자 설정 필요 상태로 표시됩니다.",
      ].join("\n"),
      ephemeral: true,
    });
    return true;
  }

  if (parsed.action === "refresh") {
    await refreshHub(interaction, project);
    return true;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: "권한이 없습니다. 프로젝트 관리 권한이 있는 사용자만 사용할 수 있습니다.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.reply(projectAdminPanel(project, storedProjectHealth(project)));
  return true;
}
