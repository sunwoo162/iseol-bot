import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { config } from "../config.js";
import { FigmaWebhookService, NO_FIGMA_VERSION, type FigmaComment, type FigmaVersion } from "./figma.js";
import { listProjects, updateProject, type StoredProject } from "./projects.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

async function getFigmaChannel(client: Client, project: StoredProject): Promise<TextChannel | null> {
  if (!project.figmaChannelId) return null;

  const channel = await client.channels.fetch(project.figmaChannelId).catch(() => null);
  if (!(channel instanceof TextChannel)) {
    console.warn(`Figma 알림 채널을 찾지 못했습니다: ${project.figmaChannelId}`);
    return null;
  }

  return channel;
}

async function notifyVersion(client: Client, project: StoredProject, version: FigmaVersion): Promise<void> {
  const channel = await getFigmaChannel(client, project);
  if (!channel) return;

  const fields = [
    { name: "버전", value: version.label || "이름 없음", inline: true },
    { name: "작성자", value: version.user?.handle || "알 수 없음", inline: true },
  ];

  if (version.description?.trim()) {
    fields.push({ name: "설명", value: version.description.trim().slice(0, 1024), inline: false });
  }

  const embed = new EmbedBuilder()
    .setTitle("🎨 Figma 디자인 버전 업데이트")
    .setDescription(`**${project.name}** 프로젝트에 새 이름 있는 버전이 생성되었습니다.`)
    .addFields(fields);

  if (project.figmaUrl) {
    embed.setURL(project.figmaUrl);
  }

  const createdAt = new Date(version.created_at);
  if (!Number.isNaN(createdAt.getTime())) {
    embed.setTimestamp(createdAt);
  }

  await channel.send({ embeds: [embed] });
}

async function notifyComment(client: Client, project: StoredProject, comment: FigmaComment): Promise<void> {
  const channel = await getFigmaChannel(client, project);
  if (!channel) return;

  const message = comment.message?.trim() || "댓글 내용을 불러올 수 없습니다.";
  const embed = new EmbedBuilder()
    .setTitle(comment.parent_id ? "↩️ Figma 새 답글" : "💬 Figma 새 댓글")
    .setDescription(message.slice(0, 4096))
    .addFields(
      { name: "작성자", value: comment.user?.handle || "알 수 없음", inline: true },
      { name: "프로젝트", value: project.name, inline: true },
    );

  if (project.figmaUrl) {
    embed.setURL(project.figmaUrl);
  }

  const createdAt = new Date(comment.created_at);
  if (!Number.isNaN(createdAt.getTime())) {
    embed.setTimestamp(createdAt);
  }

  await channel.send({ embeds: [embed] });
}

async function pollProjectVersions(client: Client, figma: FigmaWebhookService, project: StoredProject): Promise<void> {
  if (!project.figmaFileKey || !project.figmaChannelId) return;

  const versions = await figma.listNamedVersions(project.figmaFileKey);
  const latest = versions.at(-1);
  if (!latest) return;

  const cursor = project.figmaLastVersionId ?? project.figmaWebhookId;

  if (!cursor) {
    await updateProject(project.id, {
      figmaLastVersionId: latest.id,
      figmaWebhookId: latest.id,
    });
    return;
  }

  let newVersions: FigmaVersion[] = [];

  if (cursor === NO_FIGMA_VERSION) {
    newVersions = versions;
  } else {
    const cursorIndex = versions.findIndex((version) => version.id === cursor);

    if (cursorIndex < 0) {
      await updateProject(project.id, {
        figmaLastVersionId: latest.id,
        figmaWebhookId: latest.id,
      });
      return;
    }

    newVersions = versions.slice(cursorIndex + 1);
  }

  for (const version of newVersions) {
    await notifyVersion(client, project, version);
    await updateProject(project.id, {
      figmaLastVersionId: version.id,
      figmaWebhookId: version.id,
    });
  }
}

async function pollProjectComments(client: Client, figma: FigmaWebhookService, project: StoredProject): Promise<void> {
  if (!project.figmaFileKey || !project.figmaChannelId) return;

  const comments = await figma.listComments(project.figmaFileKey);
  const currentIds = comments.map((comment) => comment.id);

  if (!project.figmaKnownCommentIds) {
    await updateProject(project.id, { figmaKnownCommentIds: currentIds });
    return;
  }

  const knownIds = new Set(project.figmaKnownCommentIds);
  const newComments = comments.filter((comment) => !knownIds.has(comment.id));

  for (const comment of newComments) {
    await notifyComment(client, project, comment);
    knownIds.add(comment.id);
    await updateProject(project.id, { figmaKnownCommentIds: [...knownIds] });
  }

  await updateProject(project.id, { figmaKnownCommentIds: currentIds });
}

async function pollAllProjects(client: Client): Promise<void> {
  const figma = new FigmaWebhookService(config.figmaToken);
  const projects = await listProjects();

  for (const project of projects) {
    try {
      await pollProjectVersions(client, figma, project);
    } catch (error) {
      console.error(`Figma 버전 확인 실패 (${project.name})`, error);
    }

    try {
      await pollProjectComments(client, figma, project);
    } catch (error) {
      console.error(`Figma 댓글 확인 실패 (${project.name})`, error);
    }
  }
}

export function startWebhookServer(client: Client): NodeJS.Timeout {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;

    try {
      await pollAllProjects(client);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), POLL_INTERVAL_MS);
  console.log("Figma 이름 있는 버전/댓글 감시 시작: 5분 간격");
  return timer;
}
