import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import type { GitHubAccountLink } from "./github-user.js";
import type { StoredProject } from "./projects.js";

export type ProjectGitHubAction = "connect" | "profile" | "join" | "disconnect";

export function buildProjectGitHubId(action: ProjectGitHubAction, projectId: string): string {
  return `project_github:${action}:${projectId}`;
}

export function parseProjectGitHubId(customId: string): {
  action: ProjectGitHubAction;
  projectId: string;
} | null {
  const match = /^project_github:(connect|profile|join|disconnect):([A-Za-z0-9_-]+)$/.exec(customId);
  return match
    ? { action: match[1] as ProjectGitHubAction, projectId: match[2]! }
    : null;
}

export function buildGitHubConnectModalId(projectId: string): string {
  return `project_github_connect_modal:${projectId}`;
}

export function parseGitHubConnectModalId(customId: string): { projectId: string } | null {
  const match = /^project_github_connect_modal:([A-Za-z0-9_-]+)$/.exec(customId);
  return match ? { projectId: match[1]! } : null;
}

export function normalizeGitHubUsername(value: string): string {
  const username = value.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) {
    throw new Error("올바른 GitHub 사용자명을 입력해주세요.");
  }
  return username;
}

export function githubJoinUsername(link: GitHubAccountLink | null): string | null {
  return link?.githubLogin ?? null;
}

export function findDuplicateGitHubAccount(
  links: GitHubAccountLink[],
  guildId: string,
  discordUserId: string,
  githubLogin: string,
): GitHubAccountLink | null {
  const normalized = githubLogin.trim().toLowerCase();
  return links.find((link) =>
    link.guildId === guildId
    && link.discordUserId !== discordUserId
    && link.githubLogin.toLowerCase() === normalized,
  ) ?? null;
}

function repositoryLink(label: string, url: string): ButtonBuilder {
  return new ButtonBuilder()
    .setLabel(label)
    .setEmoji("🐙")
    .setStyle(ButtonStyle.Link)
    .setURL(url);
}

export function githubAccountPanel(project: StoredProject, link: GitHubAccountLink | null) {
  if (!link) {
    return {
      content: [
        `🐙 **${project.name} GitHub**`,
        "GitHub 계정 연결이 필요합니다.",
        "한 번 연결하면 이 서버의 다른 프로젝트에서도 같은 계정을 재사용합니다.",
      ].join("\n"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(buildProjectGitHubId("connect", project.id))
            .setLabel("GitHub 계정 연결")
            .setEmoji("🔗")
            .setStyle(ButtonStyle.Primary),
          repositoryLink("Frontend", project.frontend.url),
          repositoryLink("Backend", project.backend.url),
        ),
      ],
      ephemeral: true as const,
    };
  }

  return {
    content: [
      `🐙 **${project.name} GitHub**`,
      `연결 계정: **@${link.githubLogin}**`,
      `Organization: **${project.organization}**`,
      "프로젝트 참여 시 이 계정을 그대로 사용합니다.",
    ].join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildProjectGitHubId("join", project.id))
          .setLabel("Organization 참여")
          .setEmoji("🚀")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(buildProjectGitHubId("profile", project.id))
          .setLabel("내 프로필")
          .setEmoji("👤")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(buildProjectGitHubId("disconnect", project.id))
          .setLabel("연결 해제")
          .setEmoji("🔌")
          .setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        repositoryLink("Frontend", project.frontend.url),
        repositoryLink("Backend", project.backend.url),
      ),
    ],
    ephemeral: true as const,
  };
}
