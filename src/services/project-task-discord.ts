import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  Guild,
  ModalBuilder,
  ModalSubmitInteraction,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { config } from "../config.js";
import { resolveCalendarRange } from "./calendar/calendar-discord.js";
import { GoogleCalendarService } from "./calendar/google-calendar.js";
import { GitHubWebhookService, type RepositoryRef } from "./github.js";
import { findGitHubAccount } from "./github-user.js";
import {
  findProjectTask,
  listMemberProjectTasks,
  saveProjectTask,
  updateProjectTask,
  type ProjectTaskStatus,
  type StoredProjectTask,
} from "./project-task.js";
import { findProject, type StoredProject } from "./projects.js";

export type ProjectTaskAction = "create" | "my" | "complete" | "edit" | "more";

export type ProjectTaskCreatePlan = {
  repositorySide: "frontend";
  repository: RepositoryRef;
  creatorDiscordId: string;
  githubUsername?: string;
  title: string;
  body: string;
  start: string;
  end: string;
};

export type ProjectTaskCompletionPlan = {
  shouldCloseIssue: boolean;
  nextStatus: ProjectTaskStatus;
  calendarSummary: string;
};

export type ProjectTaskEditPlan = {
  title: string;
  body: string;
  start: string;
  end: string;
};

export function buildProjectTaskId(action: ProjectTaskAction, id: string): string {
  return `project_task:${action}:${id}`;
}

export function parseProjectTaskId(customId: string): { action: ProjectTaskAction; id: string } | null {
  const match = /^project_task:(create|my|complete|edit|more):([A-Za-z0-9_-]+)$/.exec(customId);
  return match ? { action: match[1] as ProjectTaskAction, id: match[2]! } : null;
}

export function projectTaskCreatePlan(
  project: StoredProject,
  creatorDiscordId: string,
  githubUsername: string | undefined,
  title: string,
  body: string,
  startText: string,
  now = new Date(),
): ProjectTaskCreatePlan {
  const range = resolveCalendarRange(startText, "", now);
  return {
    repositorySide: "frontend",
    repository: project.frontend,
    creatorDiscordId,
    ...(githubUsername ? { githubUsername } : {}),
    title: title.trim(),
    body: body.trim(),
    start: range.start,
    end: range.end,
  };
}

export function projectTaskCompletionPlan(task: StoredProjectTask): ProjectTaskCompletionPlan {
  return {
    shouldCloseIssue: task.status !== "completed",
    nextStatus: "completed",
    calendarSummary: `✅ ${task.title}`,
  };
}

export function projectTaskEditPlan(
  _task: StoredProjectTask,
  title: string,
  body: string,
  startText: string,
  now = new Date(),
): ProjectTaskEditPlan {
  const range = resolveCalendarRange(startText, "", now);
  return {
    title: title.trim(),
    body: body.trim(),
    start: range.start,
    end: range.end,
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatKstInput(value: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "";
  const shifted = new Date(instant.getTime() + 9 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())} ${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
}

function formatKstDisplay(value: string): string {
  const input = formatKstInput(value);
  if (!input) return "시간 없음";
  const [date, time] = input.split(" ");
  const [, month, day] = date!.split("-");
  return `${Number(month)}/${Number(day)} ${time}`;
}

function textInput(
  id: string,
  label: string,
  placeholder: string,
  required: boolean,
  style = TextInputStyle.Short,
  value?: string,
): ActionRowBuilder<TextInputBuilder> {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setRequired(required)
    .setStyle(style);
  if (value) input.setValue(value.slice(0, 4000));
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

export function taskCreateModal(projectId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`project_task_create_modal:${projectId}`)
    .setTitle("작업 만들기")
    .addComponents(
      textInput("title", "작업", "예: 로그인 API 연동", true),
      textInput("start", "마감", "내일 18:00", true),
      textInput("body", "설명 (선택)", "완료 조건이나 참고 내용을 적어주세요.", false, TextInputStyle.Paragraph),
    );
}

export function taskEditModal(task: StoredProjectTask): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`project_task_edit_modal:${task.id}`)
    .setTitle("작업 수정")
    .addComponents(
      textInput("title", "작업", "예: 로그인 API 연동", true, TextInputStyle.Short, task.title),
      textInput("start", "마감", "내일 18:00", true, TextInputStyle.Short, formatKstInput(task.start)),
      textInput("body", "설명 (선택)", "완료 조건이나 참고 내용을 적어주세요.", false, TextInputStyle.Paragraph, task.body),
    );
}

export function taskCardPayload(task: StoredProjectTask) {
  const completed = task.status === "completed";
  const side = task.repositorySide === "frontend" ? "Frontend" : "Backend";
  const description = [
    `👤 <@${task.creatorDiscordId}>`,
    `📅 ${formatKstDisplay(task.start)}`,
    `🐙 ${side} #${task.issueNumber}`,
    completed ? "✅ 완료" : "🟡 진행 중",
    task.body.trim() ? `\n${task.body.trim()}` : "",
  ].filter(Boolean).join("\n");

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildProjectTaskId("complete", task.id))
      .setLabel("완료")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(completed),
    new ButtonBuilder()
      .setCustomId(buildProjectTaskId("edit", task.id))
      .setLabel("수정")
      .setEmoji("✏️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildProjectTaskId("more", task.id))
      .setLabel("더보기")
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [new EmbedBuilder()
      .setTitle(`${completed ? "✅" : "📌"} ${task.title}`)
      .setDescription(description)
      .setURL(task.issueUrl)],
    components: [row],
  };
}

export function memberTaskSummary(tasks: StoredProjectTask[]): string {
  const open = tasks
    .filter((task) => task.status === "open")
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, 10);

  if (open.length === 0) return "열린 작업이 없습니다.";

  return open.map((task) => {
    const side = task.repositorySide === "frontend" ? "Frontend" : "Backend";
    return `• **${task.title}** · ${formatKstDisplay(task.start)} · [${side} #${task.issueNumber}](${task.issueUrl})`;
  }).join("\n");
}

function taskCalendarService(): GoogleCalendarService | null {
  if (!config.googleClientId || !config.googleClientSecret || !config.googleRefreshToken) return null;
  return new GoogleCalendarService(
    config.googleClientId,
    config.googleClientSecret,
    config.googleRefreshToken,
    config.googleRedirectUri,
  );
}

async function resolveTaskChannel(interaction: ModalSubmitInteraction, project: StoredProject): Promise<TextChannel | null> {
  if (!interaction.guild) return null;

  if (project.calendarChannelId) {
    const stored = await interaction.guild.channels.fetch(project.calendarChannelId).catch(() => null);
    if (stored instanceof TextChannel) return stored;
  }

  const channels = await interaction.guild.channels.fetch();
  const found = channels.find((channel) =>
    channel instanceof TextChannel
    && channel.parentId === project.categoryId
    && channel.name === "📅・일정",
  );
  return found instanceof TextChannel ? found : null;
}

async function refreshStoredTaskCard(guild: Guild | null, task: StoredProjectTask): Promise<void> {
  if (!guild || !task.discordChannelId || !task.discordMessageId) return;
  const channel = await guild.channels.fetch(task.discordChannelId).catch(() => null);
  if (!(channel instanceof TextChannel)) return;
  const message = await channel.messages.fetch(task.discordMessageId).catch(() => null);
  if (!message) return;
  await message.edit(taskCardPayload(task)).catch(() => undefined);
}

async function handleTaskCompletion(interaction: ButtonInteraction, task: StoredProjectTask): Promise<boolean> {
  const project = await findProject(task.projectId);
  if (!project || project.guildId !== interaction.guildId || task.guildId !== interaction.guildId) {
    await interaction.reply({ content: "작업의 프로젝트 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }

  const plan = projectTaskCompletionPlan(task);
  if (!plan.shouldCloseIssue) {
    await refreshStoredTaskCard(interaction.guild, task);
    await interaction.reply({ content: "이미 완료된 작업입니다.", ephemeral: true });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  const github = new GitHubWebhookService(config.githubToken);
  await github.closeIssue(task.repository, task.issueNumber);

  let calendarWarning = false;
  const calendar = taskCalendarService();
  if (calendar && project.calendarId && task.calendarEventId) {
    try {
      await calendar.updateEvent(project.calendarId, task.calendarEventId, {
        summary: plan.calendarSummary,
        description: [task.body, `GitHub Issue #${task.issueNumber}`, task.issueUrl].filter(Boolean).join("\n\n"),
        start: task.start,
        end: task.end,
        metadata: {
          iseolProjectId: project.id,
          source: "task",
          repository: task.repository,
          number: String(task.issueNumber),
          status: "completed",
        },
      });
    } catch (error) {
      calendarWarning = true;
      console.warn(`완료 작업 Calendar 갱신 실패 (${project.name} #${task.issueNumber})`, error);
    }
  }

  const updated = await updateProjectTask(task.id, { status: plan.nextStatus }) ?? { ...task, status: plan.nextStatus };
  await refreshStoredTaskCard(interaction.guild, updated);
  await interaction.editReply(`✅ **${updated.title}** 완료 · GitHub Issue Close${calendarWarning ? "\n⚠️ Calendar 완료 표시 확인 필요" : ""}`);
  return true;
}

export async function handleProjectTaskButton(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseProjectTaskId(interaction.customId);
  if (!parsed) return false;

  if (parsed.action === "create") {
    const project = await findProject(parsed.id);
    if (!project || project.guildId !== interaction.guildId) {
      await interaction.reply({ content: "프로젝트 정보를 찾을 수 없습니다.", ephemeral: true });
      return true;
    }
    await interaction.showModal(taskCreateModal(project.id));
    return true;
  }

  if (parsed.action === "my") {
    const project = await findProject(parsed.id);
    if (!project || project.guildId !== interaction.guildId) {
      await interaction.reply({ content: "프로젝트 정보를 찾을 수 없습니다.", ephemeral: true });
      return true;
    }
    const tasks = await listMemberProjectTasks(project.guildId, project.id, interaction.user.id);
    await interaction.reply({ content: `📋 **내 작업**\n${memberTaskSummary(tasks)}`, ephemeral: true });
    return true;
  }

  const task = await findProjectTask(parsed.id);
  if (!task || task.guildId !== interaction.guildId) {
    await interaction.reply({ content: "작업 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }

  if (parsed.action === "complete") return handleTaskCompletion(interaction, task);

  if (parsed.action === "edit") {
    await interaction.showModal(taskEditModal(task));
    return true;
  }

  const project = await findProject(task.projectId);
  const lines = [
    `🐙 [GitHub Issue #${task.issueNumber}](${task.issueUrl})`,
    project?.calendarUrl ? `📅 [Google Calendar 열기](${project.calendarUrl})` : "📅 Google Calendar 미연결",
  ];
  await interaction.reply({ content: lines.join("\n"), ephemeral: true });
  return true;
}

async function handleTaskEditModal(interaction: ModalSubmitInteraction, taskId: string): Promise<boolean> {
  const task = await findProjectTask(taskId);
  if (!task || task.guildId !== interaction.guildId) {
    await interaction.reply({ content: "작업 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }
  const project = await findProject(task.projectId);
  if (!project || project.guildId !== interaction.guildId) {
    await interaction.reply({ content: "작업의 프로젝트 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }

  const plan = projectTaskEditPlan(
    task,
    interaction.fields.getTextInputValue("title"),
    interaction.fields.getTextInputValue("body"),
    interaction.fields.getTextInputValue("start"),
  );
  if (!plan.title) {
    await interaction.reply({ content: "작업 제목을 입력해주세요.", ephemeral: true });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  const github = new GitHubWebhookService(config.githubToken);
  await github.updateIssue(task.repository, task.issueNumber, { title: plan.title, body: plan.body });

  let calendarWarning = false;
  const calendar = taskCalendarService();
  if (calendar && project.calendarId && task.calendarEventId) {
    try {
      await calendar.updateEvent(project.calendarId, task.calendarEventId, {
        summary: task.status === "completed" ? `✅ ${plan.title}` : `[${project.name}] ${plan.title}`,
        description: [plan.body, `GitHub Issue #${task.issueNumber}`, task.issueUrl].filter(Boolean).join("\n\n"),
        start: plan.start,
        end: plan.end,
        metadata: {
          iseolProjectId: project.id,
          source: "task",
          repository: task.repository,
          number: String(task.issueNumber),
          status: task.status,
        },
      });
    } catch (error) {
      calendarWarning = true;
      console.warn(`작업 Calendar 수정 실패 (${project.name} #${task.issueNumber})`, error);
    }
  }

  const updated = await updateProjectTask(task.id, plan) ?? { ...task, ...plan };
  await refreshStoredTaskCard(interaction.guild, updated);
  await interaction.editReply(`✅ **${updated.title}** 수정 완료${calendarWarning ? "\n⚠️ Calendar 반영 확인 필요" : ""}`);
  return true;
}

export async function handleProjectTaskModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  const edit = /^project_task_edit_modal:([A-Za-z0-9_-]+)$/.exec(interaction.customId);
  if (edit) return handleTaskEditModal(interaction, edit[1]!);

  const create = /^project_task_create_modal:([A-Za-z0-9_-]+)$/.exec(interaction.customId);
  if (!create) return false;

  const project = await findProject(create[1]!);
  if (!project || project.guildId !== interaction.guildId) {
    await interaction.reply({ content: "프로젝트 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }

  const title = interaction.fields.getTextInputValue("title").trim();
  const startText = interaction.fields.getTextInputValue("start").trim();
  const body = interaction.fields.getTextInputValue("body").trim();
  if (!title) {
    await interaction.reply({ content: "작업 제목을 입력해주세요.", ephemeral: true });
    return true;
  }

  const linkedAccount = interaction.guildId
    ? await findGitHubAccount(interaction.guildId, interaction.user.id)
    : null;
  const plan = projectTaskCreatePlan(
    project,
    interaction.user.id,
    linkedAccount?.githubLogin,
    title,
    body,
    startText,
  );

  await interaction.deferReply({ ephemeral: true });
  const github = new GitHubWebhookService(config.githubToken);
  const issue = await github.createIssue(plan.repository, plan.title, plan.body);

  let calendarEventId: string | undefined;
  let calendarWarning = false;
  const calendar = taskCalendarService();
  if (calendar && project.calendarId) {
    try {
      const event = await calendar.createEvent(project.calendarId, {
        summary: `[${project.name}] ${plan.title}`,
        description: [plan.body, `GitHub Issue #${issue.number}`, issue.htmlUrl].filter(Boolean).join("\n\n"),
        start: plan.start,
        end: plan.end,
        metadata: {
          iseolProjectId: project.id,
          source: "task",
          repository: `${plan.repository.owner}/${plan.repository.repo}`,
          number: String(issue.number),
          status: "open",
        },
      });
      calendarEventId = event.id;
    } catch (error) {
      calendarWarning = true;
      console.warn(`작업 Calendar 자동 등록 실패 (${project.name} #${issue.number})`, error);
    }
  } else if (project.calendarId) {
    calendarWarning = true;
  }

  let stored = await saveProjectTask({
    projectId: project.id,
    guildId: project.guildId,
    creatorDiscordId: plan.creatorDiscordId,
    ...(plan.githubUsername ? { githubUsername: plan.githubUsername } : {}),
    repositorySide: plan.repositorySide,
    repository: `${plan.repository.owner}/${plan.repository.repo}`,
    issueNumber: issue.number,
    issueUrl: issue.htmlUrl,
    ...(calendarEventId ? { calendarEventId } : {}),
    title: plan.title,
    body: plan.body,
    start: plan.start,
    end: plan.end,
    status: "open",
  });

  const channel = await resolveTaskChannel(interaction, project);
  let cardWarning = false;
  if (channel) {
    try {
      const message = await channel.send(taskCardPayload(stored));
      stored = await updateProjectTask(stored.id, {
        discordChannelId: channel.id,
        discordMessageId: message.id,
      }) ?? stored;
    } catch (error) {
      cardWarning = true;
      console.warn(`Discord 작업 카드 생성 실패 (${project.name} #${issue.number})`, error);
    }
  } else {
    cardWarning = true;
  }

  const warnings = [
    calendarWarning ? "Calendar 연동 확인 필요" : "",
    cardWarning ? "일정 채널 자동 복구 필요" : "",
  ].filter(Boolean);
  const warningText = warnings.length ? `\n⚠️ ${warnings.join(" · ")}` : "";
  await interaction.editReply(`✅ **${stored.title}** 작업 생성 완료 · GitHub #${stored.issueNumber}${warningText}\n${stored.issueUrl}`);
  return true;
}
