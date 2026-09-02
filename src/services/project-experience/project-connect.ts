import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import type { StoredProject } from "../projects.js";
import { projectHealthLines, type ProjectHealth } from "./project-health.js";

export type ProjectConnectAction = "open" | "auto" | "github" | "calendar";

export function buildProjectConnectId(action: ProjectConnectAction, projectId: string): string {
  return `project_connect:${action}:${projectId}`;
}

export function parseProjectConnectId(customId: string): {
  action: ProjectConnectAction;
  projectId: string;
} | null {
  const match = /^project_connect:(open|auto|github|calendar):([A-Za-z0-9_-]+)$/.exec(customId);
  return match
    ? { action: match[1] as ProjectConnectAction, projectId: match[2]! }
    : null;
}

export function hasQuickConnectIssue(health: ProjectHealth): boolean {
  return health.github !== "connected"
    || health.calendar !== "connected"
    || health.scrum !== "connected"
    || health.notion !== "connected"
    || health.figma !== "connected"
    || health.review === "repair"
    || health.review === "needs_admin";
}

export function projectQuickConnectPanel(project: StoredProject, health: ProjectHealth) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildProjectConnectId("auto", project.id))
      .setLabel("가능한 항목 자동 연결")
      .setEmoji("🚀")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(buildProjectConnectId("github", project.id))
      .setLabel("GitHub 복구")
      .setEmoji("🐙")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildProjectConnectId("calendar", project.id))
      .setLabel("Calendar 만들기")
      .setEmoji("📅")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`project_settings:notion:${project.id}`)
      .setLabel("Notion 설정")
      .setEmoji("📄")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`project_settings:figma:${project.id}`)
      .setLabel("Figma 설정")
      .setEmoji("🎨")
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [new EmbedBuilder()
      .setTitle(`⚡ ${project.name} 빠른 연동`)
      .setDescription([
        projectHealthLines(health).join("\n"),
        "",
        "`가능한 항목 자동 연결`을 누르면 이설이 Discord · GitHub · Calendar를 가능한 범위에서 한 번에 정리합니다.",
        "Notion/Figma는 링크만 붙여넣으면 됩니다.",
        "프로젝트 설정 변경에는 Discord 프로젝트 관리 권한이 필요합니다.",
      ].join("\n"))],
    components: [row],
    ephemeral: true as const,
  };
}
