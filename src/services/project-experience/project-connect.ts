import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import type { StoredProject } from "../projects.js";
import { projectHealthLines, type ProjectHealth } from "./project-health.js";

export type ProjectConnectAction = "open" | "auto" | "github" | "calendar" | "github_help";

export function buildProjectConnectId(action: ProjectConnectAction, projectId: string): string {
  return `project_connect:${action}:${projectId}`;
}

export function parseProjectConnectId(customId: string): {
  action: ProjectConnectAction;
  projectId: string;
} | null {
  const match = /^project_connect:(open|auto|github|calendar|github_help):([A-Za-z0-9_-]+)$/.exec(customId);
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

export function projectGitHubPermissionGuide(project: StoredProject) {
  const linkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("GitHub 토큰 설정 열기")
      .setEmoji("🔐")
      .setStyle(ButtonStyle.Link)
      .setURL("https://github.com/settings/personal-access-tokens"),
  );

  return {
    embeds: [new EmbedBuilder()
      .setTitle(`🔐 ${project.name} · GitHub 자동화 권한`)
      .setDescription([
        "이설 서버의 `GITHUB_TOKEN`에 아래 저장소 권한이 필요합니다.",
        "",
        "• Metadata · Read",
        "• Contents · Read/write",
        "• Workflows · Read/write",
        "• Actions · Read",
        "• Pull requests · Read/write",
        "• Issues · Read/write",
        "• Webhooks · Read/write",
        "",
        "Frontend/Backend 저장소가 토큰의 Repository access에 포함되어 있는지도 확인해주세요.",
        "권한 수정 후 서버 환경변수를 갱신하고 이설을 재시작한 다음 `🚀 가능한 항목 자동 연결`을 다시 누르면 됩니다.",
        "보안을 위해 PAT 값 자체는 Discord에서 입력하거나 표시하지 않습니다.",
      ].join("\n"))],
    components: [linkRow],
    ephemeral: true as const,
  };
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

  const helpRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildProjectConnectId("github_help", project.id))
      .setLabel("GitHub 권한 안내")
      .setEmoji("🔐")
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
    components: [row, helpRow],
    ephemeral: true as const,
  };
}
