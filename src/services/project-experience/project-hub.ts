import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  TextChannel,
} from "discord.js";
import type { StoredProject } from "../projects.js";
import { buildProjectHubId } from "./project-custom-id.js";
import { projectHealthLines, type ProjectHealth } from "./project-health.js";

function linkButton(label: string, url: string, emoji?: string): ButtonBuilder {
  const button = new ButtonBuilder()
    .setLabel(label)
    .setStyle(ButtonStyle.Link)
    .setURL(url);
  if (emoji) button.setEmoji(emoji);
  return button;
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

  const components: ActionRowBuilder<ButtonBuilder>[] = [memberRow];
  const links = [
    project.notionUrl ? linkButton("Notion", project.notionUrl, "📄") : null,
    project.figmaUrl ? linkButton("Figma", project.figmaUrl, "🎨") : null,
    linkButton("Frontend", project.frontend.url, "🐙"),
    linkButton("Backend", project.backend.url, "🐙"),
  ].filter((button): button is ButtonBuilder => Boolean(button));

  if (links.length > 0) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...links));
  }

  return { embeds: [embed], components };
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
