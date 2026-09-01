import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  TextChannel,
} from "discord.js";
import type { StoredProject } from "./projects.js";

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

export async function ensureScrumPanel(
  channel: TextChannel,
  project: StoredProject,
): Promise<string> {
  if (project.scrumPanelMessageId) {
    const existing = await channel.messages.fetch(project.scrumPanelMessageId).catch(() => null);
    if (existing) {
      await existing.edit(scrumPanelMessage(project));
      if (!existing.pinned) await existing.pin().catch(() => undefined);
      return existing.id;
    }
  }

  const created = await channel.send(scrumPanelMessage(project));
  await created.pin().catch(() => undefined);
  return created.id;
}
