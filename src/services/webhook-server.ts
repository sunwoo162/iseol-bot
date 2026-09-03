import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { config } from "../config.js";
import { FigmaWebhookService, NO_FIGMA_VERSION, type FigmaComment, type FigmaVersion } from "./figma.js";
import { NotionService, type NotionPageSnapshot } from "./notion.js";
import { findProject, listProjects, updateProject, type StoredProject } from "./projects.js";
import { CalendarStateStore } from "./calendar/calendar-state.js";
import { GoogleCalendarService } from "./calendar/google-calendar.js";
import {
  GoogleOAuthTokenStore,
  buildGoogleOAuthRedirectUri,
  consumeGoogleOAuthSession,
  exchangeGoogleAuthorizationCode,
} from "./calendar/google-oauth.js";
import { GitHubScheduleSyncService } from "./github-schedule-sync.js";
import { shouldReviewPullRequestAction, verifyGitHubSignature } from "./github-webhook.js";
import { refreshProjectHubForProject } from "./project-experience/project-hub.js";
import { GeminiReviewProvider } from "./review/gemini-review-provider.js";
import { GitHubReviewService } from "./review/github-review.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

export function integrationHealthPayload(): { ok: true; service: "iseol" } {
  return { ok: true, service: "iseol" };
}

async function getFigmaChannel(client: Client, project: StoredProject): Promise<TextChannel | null> {
  if (!project.figmaChannelId) return null;

  const channel = await client.channels.fetch(project.figmaChannelId).catch(() => null);
  if (!(channel instanceof TextChannel)) {
    console.warn(`Figma 알림 채널을 찾지 못했습니다: ${project.figmaChannelId}`);
    return null;
  }

  return channel;
}

async function getNotionChannel(client: Client, project: StoredProject): Promise<TextChannel | null> {
  if (!project.notionChannelId) return null;

  const channel = await client.channels.fetch(project.notionChannelId).catch(() => null);
  if (!(channel instanceof TextChannel)) {
    console.warn(`Notion 알림 채널을 찾지 못했습니다: ${project.notionChannelId}`);
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

  if (project.figmaUrl) embed.setURL(project.figmaUrl);
  const createdAt = new Date(version.created_at);
  if (!Number.isNaN(createdAt.getTime())) embed.setTimestamp(createdAt);
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

  if (project.figmaUrl) embed.setURL(project.figmaUrl);
  const createdAt = new Date(comment.created_at);
  if (!Number.isNaN(createdAt.getTime())) embed.setTimestamp(createdAt);
  await channel.send({ embeds: [embed] });
}

async function notifyNotionUpdate(client: Client, project: StoredProject, page: NotionPageSnapshot): Promise<void> {
  const channel = await getNotionChannel(client, project);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle("📝 Notion 기능명세서 업데이트")
    .setDescription(`**${project.name}** 프로젝트의 기능명세서가 수정되었습니다.`);

  if (project.notionUrl) embed.setURL(project.notionUrl);
  const editedAt = new Date(page.last_edited_time);
  if (!Number.isNaN(editedAt.getTime())) embed.setTimestamp(editedAt);
  await channel.send({ embeds: [embed] });
}

async function pollProjectVersions(client: Client, figma: FigmaWebhookService, project: StoredProject): Promise<void> {
  if (!project.figmaFileKey || !project.figmaChannelId) return;

  const versions = await figma.listNamedVersions(project.figmaFileKey);
  const latest = versions.at(-1);
  if (!latest) return;

  const cursor = project.figmaLastVersionId ?? project.figmaWebhookId;
  if (!cursor) {
    await updateProject(project.id, { figmaLastVersionId: latest.id, figmaWebhookId: latest.id });
    return;
  }

  let newVersions: FigmaVersion[] = [];
  if (cursor === NO_FIGMA_VERSION) {
    newVersions = versions;
  } else {
    const cursorIndex = versions.findIndex((version) => version.id === cursor);
    if (cursorIndex < 0) {
      await updateProject(project.id, { figmaLastVersionId: latest.id, figmaWebhookId: latest.id });
      return;
    }
    newVersions = versions.slice(cursorIndex + 1);
  }

  for (const version of newVersions) {
    await notifyVersion(client, project, version);
    await updateProject(project.id, { figmaLastVersionId: version.id, figmaWebhookId: version.id });
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

async function pollProjectNotion(client: Client, notion: NotionService, project: StoredProject): Promise<void> {
  if (!project.notionPageId || !project.notionChannelId) return;

  const page = await notion.getPage(project.notionPageId);
  const previous = project.notionLastEditedTime;
  if (!previous) {
    await updateProject(project.id, { notionLastEditedTime: page.last_edited_time });
    return;
  }
  if (page.last_edited_time === previous) return;

  const previousTime = new Date(previous).getTime();
  const currentTime = new Date(page.last_edited_time).getTime();
  if (!Number.isNaN(previousTime) && !Number.isNaN(currentTime) && currentTime <= previousTime) {
    await updateProject(project.id, { notionLastEditedTime: page.last_edited_time });
    return;
  }

  await notifyNotionUpdate(client, project, page);
  await updateProject(project.id, { notionLastEditedTime: page.last_edited_time });
}

async function pollAllProjects(client: Client): Promise<void> {
  const figma = new FigmaWebhookService(config.figmaToken);
  const notion = new NotionService(config.notionToken);
  const projects = await listProjects();

  for (const project of projects) {
    try { await pollProjectVersions(client, figma, project); }
    catch (error) { console.error(`Figma 버전 확인 실패 (${project.name})`, error); }
    try { await pollProjectComments(client, figma, project); }
    catch (error) { console.error(`Figma 댓글 확인 실패 (${project.name})`, error); }
    try { await pollProjectNotion(client, notion, project); }
    catch (error) { console.error(`Notion 수정 확인 실패 (${project.name})`, error); }
  }
}

function repositoryName(project: StoredProject, side: "frontend" | "backend"): string {
  const repo = project[side];
  return (repo.owner + "/" + repo.repo).toLowerCase();
}

async function projectForRepository(fullName: string): Promise<{ project: StoredProject; side: "frontend" | "backend" } | null> {
  const target = fullName.toLowerCase();
  for (const project of await listProjects()) {
    if (repositoryName(project, "frontend") === target) return { project, side: "frontend" };
    if (repositoryName(project, "backend") === target) return { project, side: "backend" };
  }
  return null;
}

async function notifyGitHubAutomation(client: Client, project: StoredProject, side: "frontend" | "backend", text: string): Promise<void> {
  const channelId = side === "frontend" ? project.frontendLogChannelId : project.backendLogChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel instanceof TextChannel) await channel.send(text).catch(() => undefined);
}

async function dispatchGitHubAutomation(client: Client, event: string, payload: any): Promise<void> {
  const fullName = payload?.repository?.full_name;
  if (typeof fullName !== "string") return;
  const resolved = await projectForRepository(fullName);
  if (!resolved) return;
  const { project, side } = resolved;

  if (event === "pull_request" && shouldReviewPullRequestAction(String(payload.action ?? ""))) {
    const pullNumber = Number(payload?.pull_request?.number ?? payload?.number);
    const headSha = String(payload?.pull_request?.head?.sha ?? "");
    if (!Number.isInteger(pullNumber) || !headSha) return;
    if (!config.geminiApiKey) {
      await notifyGitHubAutomation(client, project, side, "⚠️ PR 자동 리뷰를 건너뜀: GEMINI_API_KEY가 설정되지 않았습니다.");
      return;
    }
    try {
      const reviewer = new GitHubReviewService(config.githubToken, new GeminiReviewProvider(config.geminiApiKey));
      const result = await reviewer.reviewPullRequest(fullName, pullNumber, headSha);
      if (!result.skipped) await notifyGitHubAutomation(client, project, side, "🤖 PR #" + pullNumber + " 이설 코드리뷰 완료 · inline " + result.findings + "개");
    } catch (error) {
      console.error("PR 자동 리뷰 실패 (" + fullName + "#" + pullNumber + ")", error);
      await notifyGitHubAutomation(client, project, side, "❌ PR #" + pullNumber + " 이설 코드리뷰 실패 · 서버 로그를 확인해주세요.");
    }
    return;
  }

  if (event === "milestone" && project.calendarId) {
    if (!config.googleClientId || !config.googleClientSecret || !config.googleRefreshToken) return;
    const milestone = payload?.milestone;
    if (!milestone || typeof milestone.number !== "number") return;
    const service = new GitHubScheduleSyncService(
      new GoogleCalendarService(config.googleClientId, config.googleClientSecret, config.googleRefreshToken, config.googleRedirectUri),
      new CalendarStateStore(),
    );
    await service.syncMilestone(project.id, project.calendarId, fullName, {
      number: milestone.number,
      title: String(milestone.title ?? ("Milestone #" + milestone.number)),
      dueOn: typeof milestone.due_on === "string" ? milestone.due_on : null,
      state: milestone.state === "closed" || payload.action === "deleted" ? "closed" : "open",
      htmlUrl: String(milestone.html_url ?? ""),
    });
  }
}

function htmlResponse(res: ServerResponse, status: number, title: string, message: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:40px;max-width:640px;margin:auto"><h1>${title}</h1><p>${message}</p></body></html>`);
}

async function handleGoogleOAuthCallback(client: Client, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const redirectUri = buildGoogleOAuthRedirectUri(config.publicBaseUrl, config.googleRedirectUri);
    if (!config.googleClientId || !config.googleClientSecret || !redirectUri) {
      htmlResponse(res, 503, "연결 준비 필요", "이설 서버의 Google OAuth 설정을 먼저 완료해주세요.");
      return;
    }

    const requestUrl = new URL(req.url ?? "/", config.publicBaseUrl || "http://localhost");
    const state = requestUrl.searchParams.get("state") ?? "";
    const code = requestUrl.searchParams.get("code") ?? "";
    const oauthError = requestUrl.searchParams.get("error") ?? "";
    if (oauthError) {
      htmlResponse(res, 400, "Google Calendar 연결 취소", "권한 승인이 취소되었습니다. Discord에서 다시 시도해주세요.");
      return;
    }
    const session = state ? consumeGoogleOAuthSession(state) : null;
    if (!session || !code) {
      htmlResponse(res, 400, "연결 요청 만료", "Discord에서 Calendar 연결 버튼을 다시 눌러주세요.");
      return;
    }

    const project = await findProject(session.projectId);
    if (!project || project.guildId !== session.guildId) {
      htmlResponse(res, 404, "프로젝트 없음", "연결할 프로젝트를 찾을 수 없습니다.");
      return;
    }

    const refreshToken = await exchangeGoogleAuthorizationCode({
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      redirectUri,
      code,
    });
    await new GoogleOAuthTokenStore().saveRefreshToken(refreshToken);
    config.googleRefreshToken = refreshToken;

    let latest = project;
    if (!project.calendarId) {
      const calendar = await new GoogleCalendarService(
        config.googleClientId,
        config.googleClientSecret,
        refreshToken,
        redirectUri,
      ).createProjectCalendar(project.name);
      latest = await updateProject(project.id, { calendarId: calendar.id, calendarUrl: calendar.url }) ?? project;
    }
    await refreshProjectHubForProject(client, latest).catch(() => false);

    console.log(`Google Calendar OAuth 연결 완료 (${project.name}/${session.userId})`);
    htmlResponse(res, 200, "✅ Google Calendar 연결 완료", "Calendar가 프로젝트에 연결되었습니다. Discord로 돌아가면 바로 사용할 수 있습니다.");
  } catch (error) {
    console.error("Google Calendar OAuth callback 실패", error);
    htmlResponse(res, 500, "연결 실패", "Google Calendar 연결에 실패했습니다. Discord에서 다시 시도하거나 관리자에게 문의해주세요.");
  }
}

function startIntegrationHttpServer(client: Client): void {
  const redirectUri = buildGoogleOAuthRedirectUri(config.publicBaseUrl, config.googleRedirectUri);
  const googleEnabled = Boolean(config.googleClientId && config.googleClientSecret && redirectUri);
  const githubEnabled = Boolean(config.githubWebhookSecret);

  let googleCallbackPath = "/google/oauth/callback";
  if (redirectUri) {
    try { googleCallbackPath = new URL(redirectUri).pathname; } catch { /* use default */ }
  }

  const port = Number(process.env.WEBHOOK_PORT || process.env.PORT || "8787");
  const server = createServer((req, res) => {
    const path = req.url?.split("?")[0] ?? "/";
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(integrationHealthPayload()));
      return;
    }

    if (req.method === "GET" && googleEnabled && path === googleCallbackPath) {
      void handleGoogleOAuthCallback(client, req, res);
      return;
    }

    if (req.method !== "POST" || path !== "/github/events" || !githubEnabled) {
      res.writeHead(404).end("not found");
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { tooLarge = true; return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) { res.writeHead(413).end("payload too large"); return; }
      const body = Buffer.concat(chunks);
      const signature = req.headers["x-hub-signature-256"];
      if (!verifyGitHubSignature(config.githubWebhookSecret, body, Array.isArray(signature) ? signature[0] : signature)) {
        res.writeHead(401).end("invalid signature");
        return;
      }
      let payload: unknown;
      try { payload = JSON.parse(body.toString("utf8")); }
      catch { res.writeHead(400).end("invalid json"); return; }
      const eventHeader = req.headers["x-github-event"];
      const event = Array.isArray(eventHeader) ? eventHeader[0] : eventHeader;
      res.writeHead(202).end("accepted");
      if (event) void dispatchGitHubAutomation(client, event, payload).catch((error) => console.error("GitHub webhook 처리 실패 (" + event + ")", error));
    });
  });

  server.listen(port, () => {
    const routes = [
      "/healthz",
      githubEnabled ? "/github/events" : null,
      googleEnabled ? googleCallbackPath : null,
    ].filter(Boolean).join(", ");
    console.log(`Integration HTTP server listening: :${port} · ${routes}`);
  });
}

export function startWebhookServer(client: Client): NodeJS.Timeout {
  startIntegrationHttpServer(client);
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try { await pollAllProjects(client); }
    finally { running = false; }
  };

  void run();
  const timer = setInterval(() => void run(), POLL_INTERVAL_MS);
  console.log("Figma 버전/댓글 + Notion 수정 감시 시작: 5분 간격");
  return timer;
}