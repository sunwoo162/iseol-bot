import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { config } from "../config.js";
import { GitHubWebhookService } from "./github.js";
import {
  findGitHubAccount,
  GitHubUserService,
  linkGitHubAccount,
  listGitHubAccounts,
  type GitHubAccountLink,
  unlinkGitHubAccount,
} from "./github-user.js";
import { findProject, type StoredProject } from "./projects.js";

export type ProjectGitHubAction = "connect" | "profile" | "join" | "disconnect";

export type GitHubAccountActionPlan =
  | { kind: "connect" }
  | { kind: "connect_required" }
  | { kind: "not_linked" }
  | { kind: "join"; username: string }
  | { kind: "profile"; username: string }
  | { kind: "disconnect"; username: string };

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

export function githubAccountActionPlan(
  action: ProjectGitHubAction,
  link: GitHubAccountLink | null,
): GitHubAccountActionPlan {
  if (action === "connect") return { kind: "connect" };
  if (!link) return action === "disconnect" ? { kind: "not_linked" } : { kind: "connect_required" };
  if (action === "join") return { kind: "join", username: link.githubLogin };
  if (action === "profile") return { kind: "profile", username: link.githubLogin };
  return { kind: "disconnect", username: link.githubLogin };
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

function connectModal(project: StoredProject): ModalBuilder {
  const username = new TextInputBuilder()
    .setCustomId("github_username")
    .setLabel("GitHub 사용자명")
    .setPlaceholder("예: sunwoo162")
    .setMinLength(1)
    .setMaxLength(39)
    .setRequired(true)
    .setStyle(TextInputStyle.Short);

  return new ModalBuilder()
    .setCustomId(buildGitHubConnectModalId(project.id))
    .setTitle(`${project.name} · GitHub 연결`)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(username));
}

async function resolveProject(projectId: string, guildId: string | null): Promise<StoredProject | null> {
  if (!guildId) return null;
  const project = await findProject(projectId);
  return project?.guildId === guildId ? project : null;
}

async function inviteStoredAccount(
  interaction: ButtonInteraction,
  project: StoredProject,
  username: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    await new GitHubWebhookService(config.githubToken).inviteOrganizationMember(project.organization, username);
    await interaction.editReply(
      `✅ GitHub **@${username}** 계정으로 **${project.organization}** Organization 초대를 보냈습니다.\nGitHub 알림 또는 이메일에서 초대를 수락하면 합류가 완료됩니다.`,
    );
  } catch (error) {
    console.error(`GitHub Organization 초대 실패 (${project.organization}/@${username})`, error);
    await interaction.editReply(
      "❌ Organization 초대에 실패했습니다. 이미 멤버/초대 대기 중인지 또는 관리자 GitHub 권한 설정을 확인해주세요.",
    );
  }
}

async function showLinkedProfile(
  interaction: ButtonInteraction,
  username: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const profile = await new GitHubUserService(config.githubToken).getProfile(username);
    const details = [
      profile.bio?.trim() || null,
      profile.company ? `🏢 ${profile.company}` : null,
      profile.location ? `📍 ${profile.location}` : null,
    ].filter((value): value is string => Boolean(value));

    const embed = new EmbedBuilder()
      .setTitle(profile.name?.trim() ? `${profile.name.trim()} · @${profile.login}` : `@${profile.login}`)
      .setURL(profile.htmlUrl)
      .setThumbnail(profile.avatarUrl)
      .setDescription(details.join("\n").slice(0, 4096) || "연결된 GitHub 프로필입니다.")
      .addFields(
        { name: "📦 공개 저장소", value: String(profile.publicRepos), inline: true },
        { name: "👤 팔로워", value: String(profile.followers), inline: true },
        { name: "➡️ 팔로잉", value: String(profile.following), inline: true },
      );

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error(`GitHub 프로필 조회 실패 (@${username})`, error);
    await interaction.editReply("❌ GitHub 프로필을 불러오지 못했습니다. 다시 시도해주세요.");
  }
}

export async function handleProjectGitHubButton(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseProjectGitHubId(interaction.customId);
  if (!parsed) return false;

  const project = await resolveProject(parsed.projectId, interaction.guildId);
  if (!project || !interaction.guildId) {
    await interaction.reply({ content: "연결 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }

  const link = await findGitHubAccount(interaction.guildId, interaction.user.id);
  const plan = githubAccountActionPlan(parsed.action, link);

  if (plan.kind === "connect") {
    await interaction.showModal(connectModal(project));
    return true;
  }

  if (plan.kind === "connect_required") {
    await interaction.reply({
      content: "GitHub 계정 연결이 먼저 필요합니다. GitHub 패널에서 `GitHub 계정 연결`을 눌러주세요.",
      ephemeral: true,
    });
    return true;
  }

  if (plan.kind === "not_linked") {
    await interaction.reply({ content: "현재 연결된 GitHub 계정이 없습니다.", ephemeral: true });
    return true;
  }

  if (plan.kind === "join") {
    await inviteStoredAccount(interaction, project, plan.username);
    return true;
  }

  if (plan.kind === "profile") {
    await showLinkedProfile(interaction, plan.username);
    return true;
  }

  await unlinkGitHubAccount(interaction.guildId, interaction.user.id);
  await interaction.reply({
    ...githubAccountPanel(project, null),
    content: `✅ GitHub **@${plan.username}** 연결을 해제했습니다.\n\n${githubAccountPanel(project, null).content}`,
  });
  return true;
}

export async function handleGitHubConnectModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  const parsed = parseGitHubConnectModalId(interaction.customId);
  if (!parsed) return false;

  const project = await resolveProject(parsed.projectId, interaction.guildId);
  if (!project || !interaction.guildId) {
    await interaction.reply({ content: "연결 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }

  let username: string;
  try {
    username = normalizeGitHubUsername(interaction.fields.getTextInputValue("github_username"));
  } catch (error) {
    await interaction.reply({
      content: `❌ ${error instanceof Error ? error.message : "올바른 GitHub 사용자명을 입력해주세요."}`,
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const profile = await new GitHubUserService(config.githubToken).getProfile(username);
    const links = await listGitHubAccounts(interaction.guildId);
    const duplicate = findDuplicateGitHubAccount(links, interaction.guildId, interaction.user.id, profile.login);
    if (duplicate) {
      await interaction.editReply("❌ 이 GitHub 계정은 이 서버의 다른 Discord 사용자에게 이미 연결되어 있습니다.");
      return true;
    }

    const link = await linkGitHubAccount(interaction.guildId, interaction.user.id, profile.login);
    await interaction.editReply({
      ...githubAccountPanel(project, link),
      content: `✅ GitHub **@${profile.login}** 계정을 연결했습니다.\n앞으로 이 서버의 프로젝트 참여에 이 계정을 재사용합니다.\n\n${githubAccountPanel(project, link).content}`,
    });
  } catch (error) {
    console.error(`GitHub 계정 연결 실패 (@${username})`, error);
    await interaction.editReply("❌ GitHub 계정 연결에 실패했습니다. 사용자명을 확인하고 다시 시도해주세요.");
  }
  return true;
}

export async function handleLegacyProjectJoinButton(interaction: ButtonInteraction): Promise<boolean> {
  const match = /^project_join:([A-Za-z0-9_-]+)$/.exec(interaction.customId);
  if (!match) return false;

  const project = await resolveProject(match[1]!, interaction.guildId);
  if (!project || !interaction.guildId) {
    await interaction.reply({ content: "연결 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }

  const link = await findGitHubAccount(interaction.guildId, interaction.user.id);
  const username = githubJoinUsername(link);
  if (!username) {
    await interaction.reply({
      content: "GitHub 계정 연결이 먼저 필요합니다. 프로젝트 허브의 `GitHub` → `GitHub 계정 연결`을 눌러주세요.",
      ephemeral: true,
    });
    return true;
  }

  await inviteStoredAccount(interaction, project, username);
  return true;
}
