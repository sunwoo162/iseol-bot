import { ChannelType, Client } from "discord.js";
import { listProjects } from "./projects.js";

const DISCUSSION_CHANNEL_NAME = "💬・토론";

export async function ensureProjectDiscussionChannels(client: Client): Promise<void> {
  const projects = await listProjects();

  for (const project of projects) {
    try {
      const guild = client.guilds.cache.get(project.guildId)
        ?? await client.guilds.fetch(project.guildId).catch(() => null);
      if (!guild) continue;

      const channels = await guild.channels.fetch();
      const category = channels.get(project.categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) continue;

      const discussion = channels.find((channel) =>
        channel?.parentId === category.id
        && channel.type === ChannelType.GuildText
        && channel.name === DISCUSSION_CHANNEL_NAME,
      );
      if (discussion) continue;

      const figma = channels.find((channel) =>
        channel?.parentId === category.id
        && channel.type === ChannelType.GuildText
        && channel.name === "🎨・figma",
      );

      const created = await guild.channels.create({
        name: DISCUSSION_CHANNEL_NAME,
        type: ChannelType.GuildText,
        parent: category.id,
        reason: `${project.name} 프로젝트 토론 채널 추가`,
      });

      if (figma) {
        await created.setPosition(figma.position + 1).catch(() => undefined);
      }

      console.log(`프로젝트 토론 채널 생성 완료: ${project.name}`);
    } catch (error) {
      console.error(`프로젝트 토론 채널 확인 실패 (${project.name})`, error);
    }
  }
}
