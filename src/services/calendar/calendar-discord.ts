import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { config } from "../../config.js";
import { findProject } from "../projects.js";
import { GitHubWebhookService } from "../github.js";
import { GitHubScheduleSyncService } from "../github-schedule-sync.js";
import { CalendarStateStore } from "./calendar-state.js";
import { GoogleCalendarService } from "./google-calendar.js";

export type CalendarAction = "add" | "view" | "update" | "delete" | "issue";
export type CalendarEventSelectAction = "update" | "delete";

type CalendarEventOptionSource = {
  id?: string | null;
  summary?: string | null;
  start?: {
    dateTime?: string | null;
    date?: string | null;
  } | null;
  end?: {
    dateTime?: string | null;
    date?: string | null;
  } | null;
};

type CalendarSelectionSession = {
  projectId: string;
  eventId: string;
  action: CalendarEventSelectAction;
  expiresAt: number;
};

const CALENDAR_SELECTION_TTL_MS = 10 * 60 * 1000;
const calendarSelectionSessions = new Map<string, CalendarSelectionSession>();

export function parseCalendarCustomId(customId: string): { action: CalendarAction; projectId: string } | null {
  const match = /^calendar:(add|view|update|delete|issue):([A-Za-z0-9_-]+)$/.exec(customId);
  return match ? { action: match[1] as CalendarAction, projectId: match[2]! } : null;
}

export function parseCalendarEventSelectId(customId: string): { action: CalendarEventSelectAction; projectId: string } | null {
  const match = /^calendar_event:(update|delete):([A-Za-z0-9_-]+)$/.exec(customId);
  return match ? { action: match[1] as CalendarEventSelectAction, projectId: match[2]! } : null;
}

export function parseCalendarDeleteDecisionId(customId: string): { decision: "confirm" | "cancel"; token: string } | null {
  const match = /^calendar_delete_(confirm|cancel):([A-Za-z0-9]+)$/.exec(customId);
  return match ? { decision: match[1] as "confirm" | "cancel", token: match[2]! } : null;
}

export function parseCalendarIssueRepositorySelectId(customId: string): string | null {
  const match = /^calendar_issue_repo:([A-Za-z0-9_-]+)$/.exec(customId);
  return match?.[1] ?? null;
}

export function parseRepositorySide(value: string): "frontend" | "backend" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "frontend" || normalized === "backend") return normalized;
  throw new Error("repository는 frontend 또는 backend로 입력해주세요.");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function kstParts(now: Date): { year: number; month: number; day: number } {
  const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function isValidCalendarDate(year: number, month: number, day: number, hour: number, minute: number): boolean {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return false;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

function formatKst(year: number, month: number, day: number, hour: number, minute: number): string {
  if (!isValidCalendarDate(year, month, day, hour, minute)) {
    throw new Error("올바른 날짜/시간을 입력해주세요.");
  }
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00+09:00`;
}

function formatKstInstant(date: Date): string {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return formatKst(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    shifted.getUTCHours(),
    shifted.getUTCMinutes(),
  );
}

function formatKstInput(date: Date): string {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())} ${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
}

function eventInputDateTime(value?: string | null, date?: string | null): string {
  if (value) {
    const instant = new Date(value);
    if (!Number.isNaN(instant.getTime())) return formatKstInput(instant);
  }
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date} 09:00`;
  return "";
}

export function parseKstDateTime(value: string, now = new Date()): string {
  const input = value.trim();
  const current = kstParts(now);

  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(input);
  if (full) {
    return formatKst(Number(full[1]), Number(full[2]), Number(full[3]), Number(full[4]), Number(full[5]));
  }

  const monthDay = /^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(input);
  if (monthDay) {
    return formatKst(current.year, Number(monthDay[1]), Number(monthDay[2]), Number(monthDay[3]), Number(monthDay[4]));
  }

  const relative = /^(오늘|내일)\s+(\d{1,2}):(\d{2})$/.exec(input);
  if (relative) {
    const baseUtc = Date.UTC(current.year, current.month - 1, current.day + (relative[1] === "내일" ? 1 : 0));
    const base = new Date(baseUtc);
    return formatKst(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), Number(relative[2]), Number(relative[3]));
  }

  throw new Error("날짜는 `내일 14:00`, `9/3 14:00`, `2026-09-03 14:00` 형식으로 입력해주세요.");
}

export function resolveCalendarRange(
  startText: string,
  endText: string,
  now = new Date(),
): { start: string; end: string } {
  const start = parseKstDateTime(startText, now);
  const endInput = endText.trim();
  let end: string;

  if (!endInput) {
    end = formatKstInstant(new Date(new Date(start).getTime() + 60 * 60 * 1000));
  } else if (/^\d{1,2}:\d{2}$/.test(endInput)) {
    const startDate = start.slice(0, 10);
    end = parseKstDateTime(`${startDate} ${endInput}`, now);
  } else {
    end = parseKstDateTime(endInput, now);
  }

  if (new Date(end).getTime() <= new Date(start).getTime()) {
    throw new Error("종료 시간은 시작 시간보다 뒤여야 합니다.");
  }

  return { start, end };
}

function eventStartDescription(event: CalendarEventOptionSource): string {
  if (event.start?.dateTime) {
    const instant = new Date(event.start.dateTime);
    if (!Number.isNaN(instant.getTime())) {
      const shifted = new Date(instant.getTime() + 9 * 60 * 60 * 1000);
      return `${shifted.getUTCMonth() + 1}/${shifted.getUTCDate()} ${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
    }
  }

  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(event.start?.date ?? "");
  if (date) return `${Number(date[2])}/${Number(date[3])} 하루 종일`;
  return "시간 없음";
}

function truncateDiscordText(value: string, maxLength: number): string {
  const normalized = value.trim() || "제목 없음";
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

export function calendarEventSelectOptions(events: CalendarEventOptionSource[]): Array<{
  label: string;
  description: string;
  value: string;
}> {
  return events
    .filter((event): event is CalendarEventOptionSource & { id: string } => Boolean(event.id))
    .slice(0, 25)
    .map((event) => ({
      label: truncateDiscordText(event.summary ?? "제목 없음", 100),
      description: truncateDiscordText(eventStartDescription(event), 100),
      value: event.id,
    }));
}

export function calendarEventEditDefaults(event: CalendarEventOptionSource): {
  title: string;
  start: string;
  end: string;
} {
  const start = eventInputDateTime(event.start?.dateTime, event.start?.date);
  let end = eventInputDateTime(event.end?.dateTime, event.end?.date);
  if (!end && start) {
    const parsedStart = parseKstDateTime(start);
    end = formatKstInput(new Date(new Date(parsedStart).getTime() + 60 * 60 * 1000));
  }
  return {
    title: event.summary?.trim() || "제목 없음",
    start,
    end,
  };
}

function clearExpiredCalendarSelections(now = Date.now()): void {
  for (const [token, session] of calendarSelectionSessions) {
    if (session.expiresAt <= now) calendarSelectionSessions.delete(token);
  }
}

export function createCalendarSelectionSession(
  projectId: string,
  eventId: string,
  action: CalendarEventSelectAction,
  now = Date.now(),
): string {
  clearExpiredCalendarSelections(now);
  const token = randomUUID().replaceAll("-", "").slice(0, 24);
  calendarSelectionSessions.set(token, {
    projectId,
    eventId,
    action,
    expiresAt: now + CALENDAR_SELECTION_TTL_MS,
  });
  return token;
}

export function getCalendarSelectionSession(token: string, now = Date.now()): CalendarSelectionSession | null {
  clearExpiredCalendarSelections(now);
  const session = calendarSelectionSessions.get(token);
  if (!session || session.expiresAt <= now) {
    calendarSelectionSessions.delete(token);
    return null;
  }
  return { ...session };
}

function removeCalendarSelectionSession(token: string): void {
  calendarSelectionSessions.delete(token);
}

export function calendarPanelDescription(calendarUrl?: string): string {
  return [
    "프로젝트 일정을 이설에서 바로 관리합니다.",
    "`일정 추가` · `일정 보기` · `일정 수정` · `일정 삭제` · `GitHub Issue 생성`",
    calendarUrl ? `[Google Calendar 열기](${calendarUrl})` : "Google Calendar OAuth 설정이 필요합니다.",
  ].join("\n");
}

export function calendarPanel(projectId: string, calendarUrl?: string) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`calendar:add:${projectId}`).setLabel("일정 추가").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`calendar:view:${projectId}`).setLabel("일정 보기").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`calendar:update:${projectId}`).setLabel("일정 수정").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`calendar:delete:${projectId}`).setLabel("일정 삭제").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`calendar:issue:${projectId}`).setLabel("GitHub Issue 생성").setStyle(ButtonStyle.Success),
  );
  return {
    embeds: [new EmbedBuilder().setTitle("📅 프로젝트 일정").setDescription(calendarPanelDescription(calendarUrl))],
    components: [row],
  };
}

function calendarService(): GoogleCalendarService {
  return new GoogleCalendarService(config.googleClientId, config.googleClientSecret, config.googleRefreshToken, config.googleRedirectUri);
}

function textInput(
  id: string,
  label: string,
  placeholder: string,
  style = TextInputStyle.Short,
  required = true,
) {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setPlaceholder(placeholder)
      .setRequired(required)
      .setStyle(style),
  );
}

function prefilledTextInput(id: string, label: string, placeholder: string, value: string, required = true) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setRequired(required)
    .setStyle(TextInputStyle.Short);
  if (value) input.setValue(value.slice(0, 4000));
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

export function calendarIssueRepositorySelect(projectId: string): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`calendar_issue_repo:${projectId}`)
    .setPlaceholder("Issue를 만들 저장소 선택")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel("Frontend").setValue("frontend").setDescription("Frontend 저장소에 Issue 생성"),
      new StringSelectMenuOptionBuilder().setLabel("Backend").setValue("backend").setDescription("Backend 저장소에 Issue 생성"),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function calendarIssueModal(projectId: string, side: "frontend" | "backend"): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`calendar_issue_modal:${projectId}:${side}`)
    .setTitle(`${side === "frontend" ? "Frontend" : "Backend"} Issue + 일정`);
  modal.addComponents(
    textInput("title", "Issue 제목", "예: 로그인 API 구현"),
    textInput("body", "Issue 내용", "완료 조건/작업 내용", TextInputStyle.Paragraph),
    textInput("start", "시작", "내일 14:00"),
    textInput("end", "종료 (선택)", "비우면 시작 + 1시간", TextInputStyle.Short, false),
  );
  return modal;
}

async function showAddEventModal(interaction: ButtonInteraction) {
  const parsed = parseCalendarCustomId(interaction.customId)!;
  const modal = new ModalBuilder().setCustomId(`calendar_add_modal:${parsed.projectId}`).setTitle("일정 추가");
  modal.addComponents(
    textInput("title", "일정 제목", "예: 로그인 API 완료"),
    textInput("start", "시작", "내일 14:00"),
    textInput("end", "종료 (선택)", "비우면 시작 + 1시간", TextInputStyle.Short, false),
  );
  await interaction.showModal(modal);
}

async function showEventSelect(interaction: ButtonInteraction, projectId: string, calendarId: string, action: CalendarEventSelectAction) {
  await interaction.deferReply({ ephemeral: true });
  const events = await calendarService().listEvents(calendarId);
  const eligible = events.filter((event): event is typeof event & { id: string } => Boolean(event.id)).slice(0, 25);
  const displayOptions = calendarEventSelectOptions(eligible);
  if (eligible.length === 0 || displayOptions.length === 0) {
    await interaction.editReply("선택할 예정 일정이 없습니다.");
    return;
  }

  const options = displayOptions.map((option, index) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(option.label)
      .setDescription(option.description)
      .setValue(createCalendarSelectionSession(projectId, eligible[index]!.id, action)),
  );

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`calendar_event:${action}:${projectId}`)
    .setPlaceholder(action === "update" ? "수정할 일정 선택" : "삭제할 일정 선택")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(...options);

  await interaction.editReply({
    content: action === "update" ? "수정할 일정을 선택해주세요." : "삭제할 일정을 선택해주세요.",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  });
}

async function handleDeleteDecision(interaction: ButtonInteraction, decision: "confirm" | "cancel", token: string): Promise<boolean> {
  const session = getCalendarSelectionSession(token);
  if (!session || session.action !== "delete") {
    await interaction.reply({ content: "선택 시간이 만료되었습니다. 다시 일정을 선택해주세요.", ephemeral: true });
    return true;
  }

  const project = await findProject(session.projectId);
  if (!project || project.guildId !== interaction.guildId || !project.calendarId) {
    await interaction.reply({ content: "프로젝트 Calendar 연결 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }

  if (decision === "cancel") {
    removeCalendarSelectionSession(token);
    await interaction.reply({ content: "일정 삭제를 취소했습니다.", ephemeral: true });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  const service = calendarService();
  const event = await service.getEvent(project.calendarId, session.eventId);
  await service.deleteEvent(project.calendarId, session.eventId);
  removeCalendarSelectionSession(token);
  await interaction.editReply(`✅ **${event.summary ?? "일정"}** 삭제 완료`);
  return true;
}

export async function handleCalendarButton(interaction: ButtonInteraction): Promise<boolean> {
  const deleteDecision = parseCalendarDeleteDecisionId(interaction.customId);
  if (deleteDecision) return handleDeleteDecision(interaction, deleteDecision.decision, deleteDecision.token);

  const parsed = parseCalendarCustomId(interaction.customId);
  if (!parsed) return false;
  const project = await findProject(parsed.projectId);
  if (!project || project.guildId !== interaction.guildId) {
    await interaction.reply({ content: "프로젝트 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }
  if (parsed.action === "add") {
    if (!project.calendarId) {
      await interaction.reply({ content: "Google Calendar OAuth 설정이 필요합니다.", ephemeral: true });
      return true;
    }
    await showAddEventModal(interaction);
    return true;
  }
  if (parsed.action === "update" || parsed.action === "delete") {
    if (!project.calendarId) {
      await interaction.reply({ content: "Google Calendar OAuth 설정이 필요합니다.", ephemeral: true });
      return true;
    }
    await showEventSelect(interaction, project.id, project.calendarId, parsed.action);
    return true;
  }
  if (parsed.action === "issue") {
    if (!project.calendarId) {
      await interaction.reply({ content: "Google Calendar OAuth 설정이 필요합니다.", ephemeral: true });
      return true;
    }
    await interaction.reply({
      content: "GitHub Issue를 생성할 저장소를 선택해주세요.",
      components: [calendarIssueRepositorySelect(project.id)],
      ephemeral: true,
    });
    return true;
  }
  if (!project.calendarId) {
    await interaction.reply({ content: "Google Calendar OAuth 설정이 필요합니다.", ephemeral: true });
    return true;
  }
  await interaction.deferReply({ ephemeral: true });
  const events = await calendarService().listEvents(project.calendarId);
  const lines = events.slice(0, 10).map((event) => `• **${event.summary ?? "제목 없음"}**\n  ${eventStartDescription(event)}`);
  await interaction.editReply(lines.length ? lines.join("\n") : "예정된 일정이 없습니다.");
  return true;
}

export async function handleCalendarSelect(interaction: StringSelectMenuInteraction): Promise<boolean> {
  const issueProjectId = parseCalendarIssueRepositorySelectId(interaction.customId);
  if (issueProjectId) {
    const project = await findProject(issueProjectId);
    if (!project || project.guildId !== interaction.guildId || !project.calendarId) {
      await interaction.reply({ content: "프로젝트 Calendar 연결 정보를 찾을 수 없습니다.", ephemeral: true });
      return true;
    }
    const side = parseRepositorySide(interaction.values[0] ?? "");
    await interaction.showModal(calendarIssueModal(project.id, side));
    return true;
  }

  const parsed = parseCalendarEventSelectId(interaction.customId);
  if (!parsed) return false;
  const project = await findProject(parsed.projectId);
  if (!project || project.guildId !== interaction.guildId || !project.calendarId) {
    await interaction.reply({ content: "프로젝트 Calendar 연결 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }

  const token = interaction.values[0] ?? "";
  const session = getCalendarSelectionSession(token);
  if (!session || session.projectId !== project.id || session.action !== parsed.action) {
    await interaction.reply({ content: "선택 시간이 만료되었습니다. 다시 일정을 선택해주세요.", ephemeral: true });
    return true;
  }

  const event = await calendarService().getEvent(project.calendarId, session.eventId);
  if (parsed.action === "update") {
    const defaults = calendarEventEditDefaults(event);
    const modal = new ModalBuilder()
      .setCustomId(`calendar_update_selected_modal:${token}`)
      .setTitle("일정 수정");
    modal.addComponents(
      prefilledTextInput("title", "일정 제목", "예: 로그인 API 완료", defaults.title),
      prefilledTextInput("start", "시작", "내일 14:00", defaults.start),
      prefilledTextInput("end", "종료 (선택)", "비우면 시작 + 1시간", defaults.end, false),
    );
    await interaction.showModal(modal);
    return true;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`calendar_delete_confirm:${token}`)
      .setLabel("삭제")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`calendar_delete_cancel:${token}`)
      .setLabel("취소")
      .setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({
    content: `**${event.summary ?? "제목 없음"}** 일정을 삭제할까요?`,
    components: [row],
    ephemeral: true,
  });
  return true;
}

export async function handleCalendarModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  const selectedUpdate = /^calendar_update_selected_modal:([A-Za-z0-9]+)$/.exec(interaction.customId);
  if (selectedUpdate) {
    const token = selectedUpdate[1]!;
    const session = getCalendarSelectionSession(token);
    if (!session || session.action !== "update") {
      await interaction.reply({ content: "선택 시간이 만료되었습니다. 다시 일정을 선택해주세요.", ephemeral: true });
      return true;
    }
    const project = await findProject(session.projectId);
    if (!project || project.guildId !== interaction.guildId || !project.calendarId) {
      await interaction.reply({ content: "프로젝트 Calendar 연결 정보를 찾을 수 없습니다.", ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });
    const title = interaction.fields.getTextInputValue("title").trim();
    const range = resolveCalendarRange(
      interaction.fields.getTextInputValue("start"),
      interaction.fields.getTextInputValue("end"),
    );
    await calendarService().updateEvent(project.calendarId, session.eventId, {
      summary: title,
      start: range.start,
      end: range.end,
      metadata: { iseolProjectId: project.id, source: "discord" },
    });
    removeCalendarSelectionSession(token);
    await interaction.editReply(`✅ **${title}** 일정 수정 완료`);
    return true;
  }

  const issue = /^calendar_issue_modal:([A-Za-z0-9_-]+):(frontend|backend)$/.exec(interaction.customId);
  if (issue) {
    const project = await findProject(issue[1]!);
    if (!project || project.guildId !== interaction.guildId || !project.calendarId) {
      await interaction.reply({ content: "프로젝트 Calendar 연결 정보를 찾을 수 없습니다.", ephemeral: true });
      return true;
    }

    const side = parseRepositorySide(issue[2]!);
    const repository = project[side];
    const title = interaction.fields.getTextInputValue("title").trim();
    const body = interaction.fields.getTextInputValue("body").trim();
    const range = resolveCalendarRange(
      interaction.fields.getTextInputValue("start"),
      interaction.fields.getTextInputValue("end"),
    );
    await interaction.deferReply({ ephemeral: true });
    const github = new GitHubWebhookService(config.githubToken);
    const linked = await new GitHubScheduleSyncService(calendarService(), new CalendarStateStore()).createLinkedIssue(
      project.id,
      project.calendarId,
      `${repository.owner}/${repository.repo}`,
      { title, body, start: range.start, end: range.end },
      { createIssue: (_repository, issueTitle, issueBody) => github.createIssue(repository, issueTitle, issueBody) },
    );
    await interaction.editReply(`✅ GitHub Issue #${linked.issueNumber} + Google Calendar 일정 생성 완료\n${linked.issueUrl}`);
    return true;
  }

  const add = /^calendar_add_modal:([A-Za-z0-9_-]+)$/.exec(interaction.customId);
  if (!add) return false;
  const project = await findProject(add[1]!);
  if (!project || project.guildId !== interaction.guildId || !project.calendarId) {
    await interaction.reply({ content: "프로젝트 Calendar 연결 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }

  const title = interaction.fields.getTextInputValue("title").trim();
  const range = resolveCalendarRange(
    interaction.fields.getTextInputValue("start"),
    interaction.fields.getTextInputValue("end"),
  );
  await interaction.deferReply({ ephemeral: true });
  await calendarService().createEvent(project.calendarId, {
    summary: title,
    start: range.start,
    end: range.end,
    metadata: { iseolProjectId: project.id, source: "discord" },
  });
  await interaction.editReply(`✅ **${title}** 일정 추가 완료`);
  return true;
}
