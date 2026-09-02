import {
  ButtonInteraction,
  ChannelType,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";
import { config } from "../../config.js";
import { GoogleCalendarService } from "../calendar/google-calendar.js";
import { GitHubWebhookService, type RepositoryRef } from "../github.js";
import { findProject, updateProject, type StoredProject } from "../projects.js";
import { ensureProjectReviewWorkflows } from "../review/review-workflow-install.js";
import { parseProjectConnectId, projectQuickConnectPanel } from "./project-connect.js";
import { refreshProjectHubForProject } from "./project-hub.js";
import { storedProjectHealth } from "./project-health.js";
import { ensureProjectExperience } from "./project-migration.js";

export type CalendarQuickConnectPlan = "already_connected" | "needs_admin" | "create";

export type QuickConnectResult = {
  connected: string[];
  unchanged: string[];
  needsAdmin: string[];
  failed: string[];
};

export function calendarQuickConnectPlan(
  project: StoredProject,
  oauthReady: boolean,
): CalendarQuickConnectPlan {
  if (project.calendarId) return "already_connected";
  return oauthReady ? "create" : "needs_admin";
}

function section(title: string, items: string[]): string | null {
  if (items.length === 0) return null;
  return `**${title}**\n${items.map((item) => `• ${item}`).join("\n")}`;
}

export function formatQuickConnectResult(result: QuickConnectResult): string {
  return [
    "⚡ **빠른 연동 결과**",
    section("연결됨", result.connected),
    section("변경 없음", result.unchanged),
    section("관리자 설정 필요", result.needsAdmin),
    section("실패", result.failed),
  ].filter((value): value is string => Boolean(value)).join("\n\n");
}

function googleOauthReady(): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret && config.googleRefreshToken);
}

function looksLikeAdminPermissionError(error: string): boolean {
  const normalized = error.toLowerCase();
  return [
    "403",
    "forbidden",
    "permission",
    "resource not accessible",
    "workflow",
  ].some((keyword) => normalized.includes(keyword));
}

async function resolveLogChannel(
  interaction: ButtonInteraction,
  project: StoredProject,
  storedId: string | undefined,
  name: string,
): Promise<TextChannel> {
  const guild = interaction.guild;
  if (!guild) throw new Error("Discord 서버를 찾을 수 없습니다.");

  const channels = await guild.channels.fetch();
  const stored = storedId ? channels.get(storedId) : null;
  if (stored instanceof TextChannel) return stored;

  const existing = channels.find((channel) =>
    channel instanceof TextChannel
    && channel.parentId === project.categoryId
    && channel.name === name,
  );
  if (existing instanceof TextChannel) return existing;

  const created = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: project.categoryId,
    reason: `${project.name} GitHub 로그 연동 자동 복구`,
  });
  if (!(created instanceof TextChannel)) throw new Error(`${name} 채널을 만들지 못했습니다.`);
  return created;
}

async function ensureDiscordWebhookUrl(channel: TextChannel, name: string): Promise<string> {
  const existing = (await channel.fetchWebhooks()).find((webhook) =>
    webhook.name === name && Boolean(webhook.url),
  );
  if (existing?.url) return existing.url;

  const created = await channel.createWebhook({
    name,
    reason: `${name} GitHub integration`,
  });
  return created.url;
}

async function ensureRepositoryLogHook(
  github: GitHubWebhookService,
  repository: RepositoryRef,
  channel: TextChannel,
  webhookName: string,
): Promise<{ id: number; created: boolean }> {
  const discordWebhookUrl = await ensureDiscordWebhookUrl(channel, webhookName);
  return github.ensureDiscordWebhook(repository, discordWebhookUrl);
}

async function ensureGitHubProjectHooks(
  interaction: ButtonInteraction,
  project: StoredProject,
  github: GitHubWebhookService,
  result: QuickConnectResult,
): Promise<StoredProject> {
  try {
    const frontendLog = await resolveLogChannel(
      interaction,
      project,
      project.frontendLogChannelId,
      "💻・frontend-log",
    );
    const backendLog = await resolveLogChannel(
      interaction,
      project,
      project.backendLogChannelId,
      "🛠・backend-log",
    );

    const [frontendHook, backendHook] = await Promise.all([
      ensureRepositoryLogHook(github, project.frontend, frontendLog, `${project.name} Frontend Log`),
      ensureRepositoryLogHook(github, project.backend, backendLog, `${project.name} Backend Log`),
    ]);

    const updated = await updateProject(project.id, {
      frontendLogChannelId: frontendLog.id,
      backendLogChannelId: backendLog.id,
      frontendHookId: frontendHook.id,
      backendHookId: backendHook.id,
    }) ?? project;

    if (frontendHook.created || backendHook.created || !project.frontendHookId || !project.backendHookId) {
      result.connected.push("GitHub 프로젝트");
    } else {
      result.unchanged.push("GitHub 프로젝트");
    }
    return updated;
  } catch (error) {
    console.error(`빠른 GitHub 프로젝트 연동 실패 (${project.name})`, error);
    const detail = error instanceof Error ? error.message : String(error);
    if (looksLikeAdminPermissionError(detail)) result.needsAdmin.push("GitHub 프로젝트");
    else result.failed.push("GitHub 프로젝트");
    return project;
  }
}

async function ensureReview(
  github: GitHubWebhookService,
  project: StoredProject,
  result: QuickConnectResult,
): Promise<void> {
  try {
    const reviews = await ensureProjectReviewWorkflows(github, project);
    let changed = false;
    let healthy = false;
    for (const review of reviews) {
      if (!review.error) {
        healthy = true;
        if (review.created) changed = true;
        continue;
      }
      console.warn(`빠른 Code Review 연동 실패 (${review.repository}): ${review.error}`);
      if (looksLikeAdminPermissionError(review.error)) {
        if (!result.needsAdmin.includes("Code Review")) result.needsAdmin.push("Code Review");
      } else if (!result.failed.includes("Code Review")) {
        result.failed.push("Code Review");
      }
    }
    if (healthy && !result.needsAdmin.includes("Code Review") && !result.failed.includes("Code Review")) {
      (changed ? result.connected : result.unchanged).push("Code Review");
    }
  } catch (error) {
    console.error(`빠른 Code Review 연동 실패 (${project.name})`, error);
    const detail = error instanceof Error ? error.message : String(error);
    if (looksLikeAdminPermissionError(detail)) result.needsAdmin.push("Code Review");
    else result.failed.push("Code Review");
  }
}

async function ensureCalendar(
  project: StoredProject,
  result: QuickConnectResult,
): Promise<StoredProject> {
  const plan = calendarQuickConnectPlan(project, googleOauthReady());
  if (plan === "already_connected") {
    result.unchanged.push("Google Calendar");
    return project;
  }
  if (plan === "needs_admin") {
    result.needsAdmin.push("Google Calendar");
    return project;
  }

  try {
    const created = await new GoogleCalendarService(
      config.googleClientId,
      config.googleClientSecret,
      config.googleRefreshToken,
      config.googleRedirectUri,
    ).createProjectCalendar(project.name);
    const updated = await updateProject(project.id, {
      calendarId: created.id,
      calendarUrl: created.url,
    }) ?? project;
    result.connected.push("Google Calendar");
    return updated;
  } catch (error) {
    console.error(`빠른 Google Calendar 연동 실패 (${project.name})`, error);
    result.failed.push("Google Calendar");
    return project;
  }
}

async function ensureDiscordExperience(
  interaction: ButtonInteraction,
  project: StoredProject,
  result: QuickConnectResult,
): Promise<StoredProject> {
  try {
    const before = [
      project.hubPanelMessageId,
      project.scrumChannelId,
      project.scrumPanelMessageId,
      project.calendarChannelId,
      project.calendarPanelMessageId,
    ].join(":");
    await ensureProjectExperience(interaction.client, project);
    const latest = await findProject(project.id) ?? project;
    const after = [
      latest.hubPanelMessageId,
      latest.scrumChannelId,
      latest.scrumPanelMessageId,
      latest.calendarChannelId,
      latest.calendarPanelMessageId,
    ].join(":");
    (before === after ? result.unchanged : result.connected).push("Discord 프로젝트 공간");
    return latest;
  } catch (error) {
    console.error(`빠른 Discord 프로젝트 복구 실패 (${project.name})`, error);
    result.failed.push("Discord 프로젝트 공간");
    return project;
  }
}

export async function handleProjectConnectButton(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseProjectConnectId(interaction.customId);
  if (!parsed) return false;

  let project = await findProject(parsed.projectId);
  if (!project || project.guildId !== interaction.guildId) {
    await interaction.reply({ content: "연결 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }

  if (parsed.action === "open") {
    await interaction.reply(projectQuickConnectPanel(project, storedProjectHealth(project)));
    return true;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: "프로젝트 연동 변경은 프로젝트 관리 권한이 있는 사용자만 할 수 있습니다.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  const result: QuickConnectResult = {
    connected: [],
    unchanged: [],
    needsAdmin: [],
    failed: [],
  };
  const github = new GitHubWebhookService(config.githubToken);

  if (parsed.action === "auto") {
    project = await ensureDiscordExperience(interaction, project, result);
  }

  if (parsed.action === "auto" || parsed.action === "github") {
    project = await ensureGitHubProjectHooks(interaction, project, github, result);
    await ensureReview(github, project, result);
  }

  if (parsed.action === "auto" || parsed.action === "calendar") {
    project = await ensureCalendar(project, result);
  }

  const latest = await findProject(project.id) ?? project;
  const hubRefreshed = await refreshProjectHubForProject(interaction.client, latest).catch(() => false);
  await interaction.editReply([
    formatQuickConnectResult(result),
    hubRefreshed ? "✅ 프로젝트 허브 상태도 갱신했습니다." : "⚠️ 허브 상태 갱신은 다음 재시작 때 다시 시도합니다.",
  ].join("\n\n"));
  return true;
}
