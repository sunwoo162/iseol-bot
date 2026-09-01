import { ChannelType, Client, TextChannel } from "discord.js";
import { calendarPanel } from "../calendar/calendar-discord.js";
import { DAILY_SCRUM_CHANNEL_NAME } from "../daily-scrum.js";
import { ensureScrumPanel } from "../daily-scrum-discord.js";
import { listProjects, updateProject, type StoredProject } from "../projects.js";
import { ensureProjectHub } from "./project-hub.js";
import { storedProjectHealth } from "./project-health.js";

export type ProjectExperienceEnsureResult = {
  hubPanelMessageId?: string;
  scrumChannelId?: string;
  scrumPanelMessageId?: string;
  calendarChannelId?: string;
  calendarPanelMessageId?: string;
};

export type ProjectExperienceMigrationPlanItem = {
  project: StoredProject;
  key: string;
  mode: "ensure" | "reuse";
};

export type ProjectCategoryCandidate = {
  id: string;
  name: string;
};

export function projectExperienceNeeds(project: StoredProject): { hub: boolean; scrum: boolean } {
  return {
    hub: !project.hubPanelMessageId,
    scrum: !project.scrumChannelId,
  };
}

export function projectCalendarExperienceNeeds(project: StoredProject): boolean {
  return !project.calendarChannelId || !project.calendarPanelMessageId;
}

export function applyEnsuredProjectExperience(
  project: StoredProject,
  ensured: ProjectExperienceEnsureResult,
): StoredProject {
  return {
    ...project,
    ...(ensured.hubPanelMessageId !== undefined ? { hubPanelMessageId: ensured.hubPanelMessageId } : {}),
    ...(ensured.scrumChannelId !== undefined ? { scrumChannelId: ensured.scrumChannelId } : {}),
    ...(ensured.scrumPanelMessageId !== undefined ? { scrumPanelMessageId: ensured.scrumPanelMessageId } : {}),
    ...(ensured.calendarChannelId !== undefined ? { calendarChannelId: ensured.calendarChannelId } : {}),
    ...(ensured.calendarPanelMessageId !== undefined ? { calendarPanelMessageId: ensured.calendarPanelMessageId } : {}),
  };
}

export function resolveProjectCategoryId(
  project: StoredProject,
  categories: ProjectCategoryCandidate[],
): string | null {
  if (categories.some((category) => category.id === project.categoryId)) {
    return project.categoryId;
  }

  const expectedName = `📁 ${project.name}`;
  const exactMatches = categories.filter((category) => category.name === expectedName);
  return exactMatches.length === 1 ? exactMatches[0]!.id : null;
}

export function planProjectExperienceMigration(
  projects: StoredProject[],
  preferredProjectIds: ReadonlySet<string> = new Set(),
): ProjectExperienceMigrationPlanItem[] {
  const groups = new Map<string, StoredProject[]>();

  for (const project of projects) {
    const key = `${project.guildId}:${project.categoryId}`;
    const group = groups.get(key) ?? [];
    group.push(project);
    groups.set(key, group);
  }

  const plan: ProjectExperienceMigrationPlanItem[] = [];
  for (const [key, group] of groups) {
    const preferredIndex = group.findIndex((project) => preferredProjectIds.has(project.id));
    const ordered = preferredIndex > 0
      ? [group[preferredIndex]!, ...group.slice(0, preferredIndex), ...group.slice(preferredIndex + 1)]
      : group;

    ordered.forEach((project, index) => {
      plan.push({ project, key, mode: index === 0 ? "ensure" : "reuse" });
    });
  }

  return plan;
}

async function ensureCalendarPanel(channel: TextChannel, project: StoredProject): Promise<string> {
  if (project.calendarPanelMessageId) {
    const existing = await channel.messages.fetch(project.calendarPanelMessageId).catch(() => null);
    if (existing) {
      await existing.edit(calendarPanel(project.id, project.calendarUrl));
      if (!existing.pinned) await existing.pin().catch(() => undefined);
      return existing.id;
    }
  }

  const created = await channel.send(calendarPanel(project.id, project.calendarUrl));
  await created.pin().catch(() => undefined);
  return created.id;
}

export async function ensureProjectExperience(
  client: Client,
  project: StoredProject,
): Promise<ProjectExperienceEnsureResult> {
  const guild = client.guilds.cache.get(project.guildId)
    ?? await client.guilds.fetch(project.guildId).catch(() => null);
  if (!guild) return {};

  const category = await guild.channels.fetch(project.categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) return {};

  let channels = await guild.channels.fetch();
  let overview = channels.find((channel) =>
    channel instanceof TextChannel
    && channel.parentId === project.categoryId
    && channel.name === "📌・프로젝트",
  );

  if (!(overview instanceof TextChannel)) {
    const created = await guild.channels.create({
      name: "📌・프로젝트",
      type: ChannelType.GuildText,
      parent: category.id,
      reason: `${project.name} 이설 프로젝트 허브 복구`,
    });
    overview = created instanceof TextChannel ? created : undefined;
    channels = await guild.channels.fetch();
  }
  if (!(overview instanceof TextChannel)) return {};

  let scrum = channels.find((channel) =>
    channel instanceof TextChannel
    && channel.parentId === project.categoryId
    && channel.name === DAILY_SCRUM_CHANNEL_NAME,
  );

  if (!(scrum instanceof TextChannel)) {
    const created = await guild.channels.create({
      name: DAILY_SCRUM_CHANNEL_NAME,
      type: ChannelType.GuildText,
      parent: category.id,
      reason: `${project.name} 이설 데일리 스크럼 자동 복구`,
    });
    scrum = created instanceof TextChannel ? created : undefined;
  }

  let calendar = channels.find((channel) =>
    channel instanceof TextChannel
    && channel.parentId === project.categoryId
    && channel.name === "📅・일정",
  );

  if (!(calendar instanceof TextChannel)) {
    const created = await guild.channels.create({
      name: "📅・일정",
      type: ChannelType.GuildText,
      parent: category.id,
      reason: `${project.name} 이설 작업 일정 자동 복구`,
    });
    calendar = created instanceof TextChannel ? created : undefined;
  }

  let current: StoredProject = project;
  if (scrum instanceof TextChannel && current.scrumChannelId !== scrum.id) {
    current = await updateProject(current.id, { scrumChannelId: scrum.id }) ?? current;
  }

  if (scrum instanceof TextChannel) {
    const scrumPanelMessageId = await ensureScrumPanel(scrum, current);
    if (current.scrumPanelMessageId !== scrumPanelMessageId) {
      current = await updateProject(current.id, { scrumPanelMessageId }) ?? current;
    }
  }

  if (calendar instanceof TextChannel && current.calendarChannelId !== calendar.id) {
    current = await updateProject(current.id, { calendarChannelId: calendar.id }) ?? current;
  }

  if (calendar instanceof TextChannel) {
    const calendarPanelMessageId = await ensureCalendarPanel(calendar, current);
    if (current.calendarPanelMessageId !== calendarPanelMessageId) {
      current = await updateProject(current.id, { calendarPanelMessageId }) ?? current;
    }
  }

  const hubPanelMessageId = await ensureProjectHub(overview, current, storedProjectHealth(current));
  if (current.hubPanelMessageId !== hubPanelMessageId) {
    const updated = await updateProject(current.id, { hubPanelMessageId });
    if (updated) {
      current = updated;
      await ensureProjectHub(overview, current, storedProjectHealth(current));
    }
  }

  return {
    hubPanelMessageId: current.hubPanelMessageId,
    scrumChannelId: current.scrumChannelId,
    scrumPanelMessageId: current.scrumPanelMessageId,
    calendarChannelId: current.calendarChannelId,
    calendarPanelMessageId: current.calendarPanelMessageId,
  };
}

async function resolveStoredProjectCategories(
  client: Client,
  projects: StoredProject[],
): Promise<{ projects: StoredProject[]; preferredProjectIds: Set<string> }> {
  const categoriesByGuild = new Map<string, ProjectCategoryCandidate[] | null>();
  const resolvedProjects: StoredProject[] = [];
  const preferredProjectIds = new Set<string>();

  for (const project of projects) {
    let categories = categoriesByGuild.get(project.guildId);
    if (categories === undefined) {
      const guild = client.guilds.cache.get(project.guildId)
        ?? await client.guilds.fetch(project.guildId).catch(() => null);
      if (!guild) {
        categoriesByGuild.set(project.guildId, null);
        console.warn(`프로젝트 UX 자동 마이그레이션 건너뜀 (${project.name}): Discord 서버를 찾을 수 없습니다.`);
        continue;
      }

      const channels = await guild.channels.fetch().catch(() => null);
      if (!channels) {
        categoriesByGuild.set(project.guildId, null);
        console.warn(`프로젝트 UX 자동 마이그레이션 건너뜀 (${project.name}): Discord 채널 목록을 읽을 수 없습니다.`);
        continue;
      }

      categories = [...channels.values()]
        .filter((channel) => channel?.type === ChannelType.GuildCategory)
        .map((channel) => ({ id: channel!.id, name: channel!.name }));
      categoriesByGuild.set(project.guildId, categories);
    }

    if (!categories) continue;

    const resolvedCategoryId = resolveProjectCategoryId(project, categories);
    if (!resolvedCategoryId) {
      console.warn(
        `프로젝트 UX 자동 마이그레이션 건너뜀 (${project.name}): 저장된 카테고리를 찾지 못했고 같은 이름의 카테고리를 하나로 특정할 수 없습니다.`,
      );
      continue;
    }

    if (resolvedCategoryId === project.categoryId) {
      preferredProjectIds.add(project.id);
      resolvedProjects.push(project);
      continue;
    }

    const updated = await updateProject(project.id, { categoryId: resolvedCategoryId });
    const resolved = updated ?? { ...project, categoryId: resolvedCategoryId };
    resolvedProjects.push(resolved);
    console.log(`프로젝트 카테고리 자동 재연결: ${project.name} (${project.categoryId} -> ${resolvedCategoryId})`);
  }

  return { projects: resolvedProjects, preferredProjectIds };
}

export async function ensureAllProjectExperiences(client: Client): Promise<void> {
  const storedProjects = await listProjects();
  const resolved = await resolveStoredProjectCategories(client, storedProjects);
  const ensuredByCategory = new Map<string, ProjectExperienceEnsureResult>();

  for (const item of planProjectExperienceMigration(resolved.projects, resolved.preferredProjectIds)) {
    const { project, key, mode } = item;
    try {
      if (mode === "reuse") {
        const existing = ensuredByCategory.get(key);
        if (existing) await updateProject(project.id, existing);
        continue;
      }

      const ensured = await ensureProjectExperience(client, project);
      ensuredByCategory.set(key, ensured);
    } catch (error) {
      console.error(`프로젝트 UX 자동 마이그레이션 실패 (${project.name})`, error);
    }
  }
}
