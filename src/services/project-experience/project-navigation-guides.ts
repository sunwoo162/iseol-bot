import { EmbedBuilder } from "discord.js";
import type { StoredProject } from "../projects.js";

export type DocumentGuideKind = "notion" | "figma";

export function discordMessageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function hubLinkLine(hubUrl?: string): string {
  return hubUrl
    ? `➡️ [📌 프로젝트 허브 열기](${hubUrl})`
    : "➡️ `📌・프로젝트` 채널에서 프로젝트 허브를 사용해주세요.";
}

export function projectHubPinnedGuide(project: StoredProject, hubUrl?: string) {
  const embed = new EmbedBuilder()
    .setTitle(`📌 ${project.name} 프로젝트 안내`)
    .setDescription([
      "고정 메시지는 안내/이동 전용입니다.",
      "실제 작업 생성·스크럼·GitHub·관리는 프로젝트 허브에서 사용합니다.",
      "",
      hubLinkLine(hubUrl),
    ].join("\n"));

  return { embeds: [embed], components: [] };
}

export function calendarPinnedGuide(project: StoredProject, hubUrl?: string) {
  const lines = [
    `**${project.name}** 작업/일정 안내입니다.`,
    "평소에는 `📌・프로젝트 → 작업 만들기`만 사용하면 됩니다.",
    "직접 일정 수정/삭제가 필요하면 `더보기 → 일정 관리`를 사용하세요.",
    "",
    hubLinkLine(hubUrl),
  ];
  if (project.calendarUrl) {
    lines.push(`📅 [Google Calendar 열기](${project.calendarUrl})`);
  }

  return {
    embeds: [new EmbedBuilder().setTitle("📅 작업 · 일정").setDescription(lines.join("\n"))],
    components: [],
  };
}

export function documentPinnedGuide(
  project: StoredProject,
  kind: DocumentGuideKind,
  hubUrl?: string,
) {
  const notion = kind === "notion";
  const title = notion ? "📄 기능명세서" : "🎨 Figma";
  const label = notion ? "Notion" : "Figma";
  const url = notion ? project.notionUrl : project.figmaUrl;
  const lines = [`**${project.name}** ${label} 안내입니다.`];

  if (url) {
    lines.push(`🔗 [${label} 열기](${url})`);
  } else {
    lines.push(`아직 ${label}가 연결되지 않았습니다.`);
    lines.push("프로젝트 허브의 `더보기 → 관리 → 연동 설정`에서 나중에 연결할 수 있습니다.");
  }
  lines.push("", hubLinkLine(hubUrl));

  return {
    embeds: [new EmbedBuilder().setTitle(title).setDescription(lines.join("\n"))],
    components: [],
  };
}
