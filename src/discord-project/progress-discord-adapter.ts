import type { Client, Message, TextChannel } from "discord.js";
import type { DiscordProgressNotification, ProgressNotificationAdapter } from "./progress-notifications.js";

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
