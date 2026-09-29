import type { Client, Message, TextChannel } from "discord.js";
import type { DiscordProgressNotification, ProgressNotificationAdapter } from "./progress-notifications.js";
import { loadDiscordProjectBinding } from "./binding-store.js";
import { listProjects, type StoredProject } from "../services/projects.js";

export type ProgressChannelResolver = (client: Client, notification: DiscordProgressNotification) => Promise<TextChannel | null>;

/** The production boundary for progress notifications. Channel lookup remains
 * injected so project binding and permission policy stay owned by the existing
 * Discord services. */
export function createDiscordProgressAdapter(client: Client, resolveChannel: ProgressChannelResolver): ProgressNotificationAdapter {
  return {
    send: async (notification) => {
      const channel = await resolveChannel(client, notification);
      if (!channel) return { accepted: false };
      const message = await channel.send({ content: notification.content, allowedMentions: { parse: [] } }) as Message;
      return { accepted: true, messageId: message.id };
    },
  };
}

export function createBoundProjectProgressChannelResolver(options: {
  bindingRoot: string;
  loadProjects?: () => Promise<StoredProject[]>;
}): ProgressChannelResolver {
  const load = options.loadProjects ?? listProjects;
  return async (client, notification) => {
    if (!notification.projectId) return null;
    const projects = await load();
    for (const project of projects) {
      const binding = await loadDiscordProjectBinding(options.bindingRoot, project.guildId, project.id);
      if (!binding || binding.projectId !== notification.projectId) continue;
      const guild = client.guilds.cache.get(project.guildId) ?? await client.guilds.fetch(project.guildId).catch(() => null);
      if (!guild) return null;
      const channelIds = [project.frontendLogChannelId, project.backendLogChannelId].filter((value): value is string => Boolean(value));
      for (const channelId of channelIds) {
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (channel && "send" in channel && typeof channel.send === "function") return channel as TextChannel;
      }
      return null;
    }
    return null;
  };
}
