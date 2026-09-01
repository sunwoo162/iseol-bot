import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { StoredProjectTask } from "./project-task.js";

export type ProjectTaskAction = "create" | "my" | "complete" | "edit" | "more";

export function buildProjectTaskId(action: ProjectTaskAction, id: string): string {
  return `project_task:${action}:${id}`;
}

export function parseProjectTaskId(customId: string): { action: ProjectTaskAction; id: string } | null {
  const match = /^project_task:(create|my|complete|edit|more):([A-Za-z0-9_-]+)$/.exec(customId);
  return match ? { action: match[1] as ProjectTaskAction, id: match[2]! } : null;
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
