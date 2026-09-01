import { ChannelType, Client, TextChannel } from "discord.js";
import { DAILY_SCRUM_CHANNEL_NAME } from "../daily-scrum.js";
import { ensureScrumPanel } from "../daily-scrum-discord.js";
import { listProjects, updateProject, type StoredProject } from "../projects.js";
import { ensureProjectHub } from "./project-hub.js";
import { storedProjectHealth } from "./project-health.js";

export type ProjectExperienceEnsureResult = {
  hubPanelMessageId?: string;
  scrumChannelId?: string;
  scrumPanelMessageId?: string;
};

export type ProjectExperienceMigrationPlanItem = {
  project: StoredProject;
  key: string;
  mode: "ensure" | "reuse";
};

export function projectExperienceNeeds(project: StoredProject): { hub: boolean; scrum: boolean } {
  return {
    hub: !project.hubPanelMessageId,
    scrum: !project.scrumChannelId,
  };
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
  };
}

export function planProjectExperienceMigration(
  projects: StoredProject[],
): ProjectExperienceMigrationPlanItem[] {
  const seenCategories = new Set<string>();
  return projects.map((project) => {
    const key = `${project.guildId}:${project.categoryId}`;
    const mode = seenCategories.has(key) ? "reuse" : "ensure";
    seenCategories.add(key);
    return { project, key, mode };
  });
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
  };
}

export async function ensureAllProjectExperiences(client: Client): Promise<void> {
  const projects = await listProjects();
  const ensuredByCategory = new Map<string, ProjectExperienceEnsureResult>();

  for (const item of planProjectExperienceMigration(projects)) {
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
