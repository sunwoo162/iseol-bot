import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import type { StoredProject } from "../projects.js";
import { projectHealthIssues, projectHealthLines, type ProjectHealth } from "./project-health.js";

export type ProjectAdminAction = "settings" | "repair" | "refresh";

export function buildProjectAdminId(action: ProjectAdminAction, projectId: string): string {
  return `project_admin:${action}:${projectId}`;
}

export function parseProjectAdminId(customId: string): {
  action: ProjectAdminAction;
  projectId: string;
} | null {
  const match = /^project_admin:(settings|repair|refresh):([A-Za-z0-9_-]+)$/.exec(customId);
  return match
    ? { action: match[1] as ProjectAdminAction, projectId: match[2]! }
    : null;
}

export function projectAdminPanel(project: StoredProject, health: ProjectHealth) {
  const issues = projectHealthIssues(health);
  const description = [
    projectHealthLines(health).join("\n"),
    "",
    issues.length > 0 ? `**확인할 항목**\n${issues.map((item) => `• ${item}`).join("\n")}` : "✅ 현재 저장된 연동 정보에서 즉시 확인할 문제는 없습니다.",
    "",
    "전역 GitHub/Google 비밀값은 Discord에서 입력하거나 표시하지 않습니다.",
  ].join("\n");

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildProjectAdminId("settings", project.id))
      .setLabel("연동 설정")
      .setEmoji("⚙️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildProjectAdminId("repair", project.id))
      .setLabel("자동 복구")
      .setEmoji("🔧")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(buildProjectAdminId("refresh", project.id))
      .setLabel("상태 새로고침")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [new EmbedBuilder()
      .setTitle(`⚙️ ${project.name} 프로젝트 관리`)
      .setDescription(description)],
    components: [row],
    ephemeral: true as const,
  };
}
