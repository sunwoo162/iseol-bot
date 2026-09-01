import { ChannelType, Client, TextChannel } from "discord.js";
import { DAILY_SCRUM_CHANNEL_NAME } from "../daily-scrum.js";
import { listProjects, updateProject, type StoredProject } from "../projects.js";
import { ensureProjectHub } from "./project-hub.js";
import type { ProjectHealth } from "./project-health.js";

export function projectExperienceNeeds(project: StoredProject): { hub: boolean; scrum: boolean } {
  return {
    hub: !project.hubPanelMessageId,
    scrum: !project.scrumChannelId,
  };
}

function storedProjectHealth(project: StoredProject): ProjectHealth {
  return {
    github: "connected",
    review: "checking",
    calendar: project.calendarId ? "connected" : "needs_setup",
    scrum: project.scrumChannelId ? "connected" : "repair",
    notion: project.notionUrl ? "connected" : "needs_setup",
    figma: project.figmaUrl ? "connected" : "needs_setup",
  };
}

async function findOrCreateTextChannel(
  project: StoredProject,
  channels: Awaited<ReturnType<NonNullable<Awaited<ReturnType<Client["guilds"]["fetch"]>>>["channels"]["fetch"]>>>,
  name: string,
): Promise<TextChannel | null> {
  const existing = channels.find((channel) =>
    channel instanceof TextChannel
    && channel.parentId === project.categoryId
    && channel.name === name,
  );
  if (existing instanceof TextChannel) return existing;
  return null;
}

export async function ensureProjectExperience(
  client: Client,
  project: StoredProject,
): Promise<{ hubPanelMessageId?: string; scrumChannelId?: string }> {
  const guild = client.guilds.cache.get(project.guildId)
    ?? await client.guilds.fetch(project.guildId).catch(() => null);
  if (!guild) return {};

  const category = await guild.channels.fetch(project.categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) return {};

  let channels = await guild.channels.fetch();
  let overview = await findOrCreateTextChannel(project, channels, "📌・프로젝트");
  if (!overview) {
    const created = await guild.channels.create({
      name: "📌・프로젝트",
      type: ChannelType.GuildText,
      parent: category.id,
      reason: `${project.name} 이설 프로젝트 허브 복구`,
    });
    overview = created instanceof TextChannel ? created : null;
    channels = await guild.channels.fetch();
  }
  if (!overview) return {};

  let scrum = await findOrCreateTextChannel(project, channels, DAILY_SCRUM_CHANNEL_NAME);
  if (!scrum) {
    const created = await guild.channels.create({
      name: DAILY_SCRUM_CHANNEL_NAME,
      type: ChannelType.GuildText,
      parent: category.id,
      reason: `${project.name} 이설 데일리 스크럼 자동 복구`,
    });
    scrum = created instanceof TextChannel ? created : null;
  }

  let current: StoredProject = project;
  if (scrum && current.scrumChannelId !== scrum.id) {
    current = await updateProject(current.id, { scrumChannelId: scrum.id }) ?? current;
  }

  const hubPanelMessageId = await ensureProjectHub(overview, current, storedProjectHealth(current));
  if (current.hubPanelMessageId !== hubPanelMessageId) {
    current = await updateProject(current.id, { hubPanelMessageId }) ?? current;
  }

  return {
    hubPanelMessageId: current.hubPanelMessageId,
    scrumChannelId: current.scrumChannelId,
  };
}

export async function ensureAllProjectExperiences(client: Client): Promise<void> {
  const projects = await listProjects();
  const ensuredByCategory = new Map<string, { hubPanelMessageId?: string; scrumChannelId?: string }>();

  for (const project of projects) {
    const key = `${project.guildId}:${project.categoryId}`;
    try {
      const existing = ensuredByCategory.get(key);
      if (existing) {
        await updateProject(project.id, existing);
        continue;
      }

      const ensured = await ensureProjectExperience(client, project);
      ensuredByCategory.set(key, ensured);
    } catch (error) {
      console.error(`프로젝트 UX 자동 마이그레이션 실패 (${project.name})`, error);
    }
  }
}
