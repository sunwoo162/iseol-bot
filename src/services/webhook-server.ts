import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { config } from "../config.js";
import type { FigmaPingPayload, FigmaVersionWebhookPayload } from "./figma.js";
import { findProjectByFigmaWebhook } from "./projects.js";

const MAX_BODY_BYTES = 1024 * 1024;

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      throw new Error("Webhook payload가 너무 큽니다.");
    }

    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text || "{}");
}

function isFigmaPayload(value: unknown): value is FigmaPingPayload | FigmaVersionWebhookPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.event_type === "string"
    && typeof payload.passcode === "string"
    && (typeof payload.webhook_id === "string" || typeof payload.webhook_id === "number");
}

async function notifyFigmaVersion(client: Client, payload: FigmaVersionWebhookPayload): Promise<void> {
  const project = await findProjectByFigmaWebhook(String(payload.webhook_id), payload.file_key);
  if (!project?.figmaChannelId) {
    console.warn(`Figma Webhook 프로젝트를 찾지 못했습니다: ${payload.webhook_id}`);
    return;
  }

  const channel = await client.channels.fetch(project.figmaChannelId).catch(() => null);
  if (!(channel instanceof TextChannel)) {
    console.warn(`Figma 알림 채널을 찾지 못했습니다: ${project.figmaChannelId}`);
    return;
  }

  const fields = [
    { name: "버전", value: payload.label || "이름 없음", inline: true },
    { name: "작성자", value: payload.triggered_by?.handle || "알 수 없음", inline: true },
  ];

  if (payload.description?.trim()) {
    fields.push({ name: "설명", value: payload.description.trim().slice(0, 1024), inline: false });
  }

  const embed = new EmbedBuilder()
    .setTitle("🎨 Figma 디자인 버전 업데이트")
    .setDescription(`**${payload.file_name}**에 새 이름 있는 버전이 생성되었습니다.`)
    .addFields(fields);

  if (project.figmaUrl) {
    embed.setURL(project.figmaUrl);
  }

  const createdAt = new Date(payload.created_at);
  if (!Number.isNaN(createdAt.getTime())) {
    embed.setTimestamp(createdAt);
  }

  await channel.send({ embeds: [embed] });
}

function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(body);
}

export function startWebhookServer(client: Client): Server {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/webhooks/figma") {
      send(response, 404, "Not Found");
      return;
    }

    let raw: unknown;
    try {
      raw = await readJsonBody(request);
    } catch (error) {
      console.error("Figma Webhook payload 처리 실패", error);
      send(response, 400, "Bad Request");
      return;
    }

    if (!isFigmaPayload(raw) || raw.passcode !== config.figmaWebhookPasscode) {
      send(response, 400, "Invalid passcode");
      return;
    }

    send(response, 200, "OK");

    if (raw.event_type === "PING") {
      console.log(`Figma Webhook PING 수신: ${raw.webhook_id}`);
      return;
    }

    if (raw.event_type === "FILE_VERSION_UPDATE") {
      void notifyFigmaVersion(client, raw as FigmaVersionWebhookPayload).catch((error) => {
        console.error("Figma 버전 알림 전송 실패", error);
      });
    }
  });

  server.listen(config.webhookPort, () => {
    console.log(`Webhook 서버 실행: http://localhost:${config.webhookPort}`);
  });

  return server;
}
