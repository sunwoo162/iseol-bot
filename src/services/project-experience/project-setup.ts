import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Guild,
  ModalSubmitInteraction,
  TextChannel,
} from "discord.js";
import { config } from "../../config.js";
import { calendarPanel } from "../calendar/calendar-discord.js";
import { GoogleCalendarService } from "../calendar/google-calendar.js";
import { DAILY_SCRUM_CHANNEL_NAME } from "../daily-scrum.js";
import { FigmaWebhookService, parseFigmaFile, type FigmaFileRef } from "../figma.js";
import {
  buildAutomationWebhookUrl,
  GitHubWebhookService,
  parseGitHubRepository,
  type RepositoryRef,
} from "../github.js";
import { NotionService, parseNotionPage, type NotionPageRef } from "../notion.js";
import {
  deleteProject,
  findProjectByRepositories,
  saveProject,
  updateProject,
  type StoredProject,
} from "../projects.js";
import { ensureProjectReviewWorkflows } from "../review/review-workflow-install.js";
import { ensureProjectHub } from "./project-hub.js";
import type { ProjectHealth } from "./project-health.js";

export type RawProjectSetupFields = {
  name: string;
  frontend: string;
  backend: string;
  notion: string;
  figma: string;
};

export type ProjectSetupInput = {
  name: string;
  frontend: RepositoryRef;
  backend: RepositoryRef;
  notion: NotionPageRef | null;
  figma: FigmaFileRef | null;
};

export type ProjectSetupWarning =
  | "github"
  | "notion"
  | "figma"
  | "calendar"
  | "review_workflow";

export type ProjectSetupResult = {
  project: StoredProject;
  warnings: ProjectSetupWarning[];
};

type GitHubHook = { repository: RepositoryRef; id: number };

export function parseProjectSetupFields(fields: RawProjectSetupFields): ProjectSetupInput {
  const name = fields.name.trim();
  if (name.length < 2 || name.length > 50) {
    throw new Error("프로젝트 이름은 2~50자로 입력해주세요.");
  }

  const frontend = parseGitHubRepository(fields.frontend.trim());
  const backend = parseGitHubRepository(fields.backend.trim());
  if (frontend.owner.toLowerCase() !== backend.owner.toLowerCase()) {
    throw new Error("Frontend와 Backend 저장소는 같은 GitHub Organization 아래에 있어야 합니다.");
  }

  const notionValue = fields.notion.trim();
  const figmaValue = fields.figma.trim();
  return {
    name,
    frontend,
    backend,
    notion: notionValue ? parseNotionPage(notionValue) : null,
    figma: figmaValue ? parseFigmaFile(figmaValue) : null,
  };
}

export async function assertProjectSetupNotDuplicate(
  guildId: string,
  input: ProjectSetupInput,
): Promise<void> {
  const duplicate = await findProjectByRepositories(guildId, input.frontend, input.backend);
  if (duplicate) {
    throw new Error(`이미 ${duplicate.name} 프로젝트에 같은 GitHub 저장소가 연결되어 있습니다.`);
  }
}

async function createTextChannel(guild: Guild, parentId: string, name: string): Promise<TextChannel> {
  const channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId });
  if (!(channel instanceof TextChannel)) throw new Error(`${name} 채널을 생성하지 못했습니다.`);
  return channel;
}

function linkRow(label: string, url: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url),
  );
}

async function patchProject(
  project: StoredProject,
  updates: Partial<Omit<StoredProject, "id">>,
): Promise<StoredProject> {
  const updated = await updateProject(project.id, updates);
  if (!updated) throw new Error("프로젝트 저장 정보를 갱신하지 못했습니다.");
  return updated;
}

function projectHealth(
  project: StoredProject,
  warnings: Set<ProjectSetupWarning>,
  reviewReady: boolean,
): ProjectHealth {
  return {
    github: warnings.has("github") ? "repair" : "connected",
    review: warnings.has("review_workflow") ? "needs_admin" : reviewReady ? "connected" : "checking",
    calendar: project.calendarId ? "connected" : warnings.has("calendar") ? "repair" : "needs_setup",
    scrum: project.scrumChannelId ? "connected" : "repair",
    notion: project.notionUrl ? warnings.has("notion") ? "repair" : "connected" : "needs_setup",
    figma: project.figmaUrl ? warnings.has("figma") ? "repair" : "connected" : "needs_setup",
  };
}

async function sendDocumentPanel(channel: TextChannel, kind: "notion" | "figma", url?: string): Promise<void> {
  const isNotion = kind === "notion";
  const title = isNotion ? "📄 기능명세서" : "🎨 Figma";
  const serviceName = isNotion ? "Notion" : "Figma";
  const embed = new EmbedBuilder().setTitle(title);

  if (url) {
    embed
      .setDescription(`${serviceName} 연동 주소입니다. 변경 알림은 연동 상태에 따라 이 채널에 기록됩니다.`)
      .setURL(url);
    const message = await channel.send({ embeds: [embed], components: [linkRow(`${serviceName} 열기`, url)] });
    await message.pin().catch(() => undefined);
    return;
  }

  embed.setDescription(`아직 ${serviceName}가 연결되지 않았습니다. 프로젝트는 그대로 사용할 수 있으며 나중에 연동할 수 있습니다.`);
  const message = await channel.send({ embeds: [embed] });
  await message.pin().catch(() => undefined);
}

export async function createProjectExperience(
  guild: Guild,
  input: ProjectSetupInput,
): Promise<ProjectSetupResult> {
  await assertProjectSetupNotDuplicate(guild.id, input);

  const github = new GitHubWebhookService(config.githubToken);
  const [frontendOwner, backendOwner] = await Promise.all([
    github.getRepositoryOwner(input.frontend),
    github.getRepositoryOwner(input.backend),
  ]);

  if (frontendOwner.login.toLowerCase() !== backendOwner.login.toLowerCase()) {
    throw new Error("Frontend와 Backend 저장소는 같은 GitHub Organization 아래에 있어야 합니다.");
  }
  if (frontendOwner.type !== "Organization" || backendOwner.type !== "Organization") {
    throw new Error(`GitHub owner "${frontendOwner.login}"가 Organization이 아닙니다.`);
  }

  const category = await guild.channels.create({
    name: `📁 ${input.name}`,
    type: ChannelType.GuildCategory,
  });
  const createdChannelIds: string[] = [];
  let storedProject: StoredProject | null = null;
  let coreReady = false;

  try {
    const overview = await createTextChannel(guild, category.id, "📌・프로젝트");
    const spec = await createTextChannel(guild, category.id, "📄・기능명세서");
    const figma = await createTextChannel(guild, category.id, "🎨・figma");
    await createTextChannel(guild, category.id, "💬・토론").then((channel) => createdChannelIds.push(channel.id));
    const scrum = await createTextChannel(guild, category.id, DAILY_SCRUM_CHANNEL_NAME);
    const frontendLog = await createTextChannel(guild, category.id, "💻・frontend-log");
    const backendLog = await createTextChannel(guild, category.id, "🛠・backend-log");
    const calendar = await createTextChannel(guild, category.id, "📅・일정");
    createdChannelIds.push(
      overview.id,
      spec.id,
      figma.id,
      scrum.id,
      frontendLog.id,
      backendLog.id,
      calendar.id,
    );

    storedProject = await saveProject({
      name: input.name,
      guildId: guild.id,
      categoryId: category.id,
      organization: frontendOwner.login,
      frontend: input.frontend,
      backend: input.backend,
      frontendLogChannelId: frontendLog.id,
      backendLogChannelId: backendLog.id,
      scrumChannelId: scrum.id,
      calendarChannelId: calendar.id,
      notionUrl: input.notion?.url,
      notionPageId: input.notion?.id,
      notionChannelId: spec.id,
      figmaUrl: input.figma?.url,
      figmaFileKey: input.figma?.key,
      figmaChannelId: figma.id,
    });

    const initialHealth = projectHealth(storedProject, new Set(), false);
    const hubPanelMessageId = await ensureProjectHub(overview, storedProject, initialHealth);
    storedProject = await patchProject(storedProject, { hubPanelMessageId });

    const scrumMessage = await scrum.send(
      "📋 **데일리 스크럼**\n매일 오전 8시 알림이 오며, 지금은 `/scrum write`도 계속 사용할 수 있습니다. 허브 버튼 작성 흐름도 자동으로 연결됩니다.",
    );
    await scrumMessage.pin().catch(() => undefined);
    storedProject = await patchProject(storedProject, { scrumPanelMessageId: scrumMessage.id });

    await sendDocumentPanel(spec, "notion", input.notion?.url);
    await sendDocumentPanel(figma, "figma", input.figma?.url);

    const calendarMessage = await calendar.send(calendarPanel(storedProject.id));
    await calendarMessage.pin().catch(() => undefined);
    storedProject = await patchProject(storedProject, { calendarPanelMessageId: calendarMessage.id });
    coreReady = true;

    const warnings = new Set<ProjectSetupWarning>();
    const hooks: GitHubHook[] = [];

    if (config.googleClientId && config.googleClientSecret && config.googleRefreshToken) {
      try {
        const createdCalendar = await new GoogleCalendarService(
          config.googleClientId,
          config.googleClientSecret,
          config.googleRefreshToken,
          config.googleRedirectUri,
        ).createProjectCalendar(input.name);
        storedProject = await patchProject(storedProject, {
          calendarId: createdCalendar.id,
          calendarUrl: createdCalendar.url,
        });
        await calendarMessage.edit(calendarPanel(storedProject.id, createdCalendar.url)).catch(() => undefined);
      } catch (error) {
        warnings.add("calendar");
        console.warn(`Google Calendar 자동 연결 실패 (${input.name})`, error);
      }
    }

    if (input.notion) {
      try {
        const snapshot = await new NotionService(config.notionToken).getPage(input.notion.id);
        storedProject = await patchProject(storedProject, { notionLastEditedTime: snapshot.last_edited_time });
      } catch (error) {
        warnings.add("notion");
        console.warn(`Notion 자동 연결 실패 (${input.name})`, error);
      }
    }

    if (input.figma) {
      try {
        const figmaService = new FigmaWebhookService(
          config.figmaToken,
          config.publicBaseUrl,
          config.figmaWebhookPasscode,
        );
        const existingComments = await figmaService.listComments(input.figma.key);
        const lastVersionId = await figmaService.createVersionWebhook(input.figma.key, `${input.name} named version notifications`);
        storedProject = await patchProject(storedProject, {
          figmaWebhookId: lastVersionId,
          figmaLastVersionId: lastVersionId,
          figmaKnownCommentIds: existingComments.map((comment) => comment.id),
        });
      } catch (error) {
        warnings.add("figma");
        console.warn(`Figma 자동 연결 실패 (${input.name})`, error);
      }
    }

    try {
      const frontDiscordWebhook = await frontendLog.createWebhook({
        name: `${input.name} Frontend Log`,
        reason: `${input.name} frontend GitHub integration`,
      });
      const frontHookId = await github.createDiscordWebhook(input.frontend, frontDiscordWebhook.url);
      hooks.push({ repository: input.frontend, id: frontHookId });

      const backDiscordWebhook = await backendLog.createWebhook({
        name: `${input.name} Backend Log`,
        reason: `${input.name} backend GitHub integration`,
      });
      const backHookId = await github.createDiscordWebhook(input.backend, backDiscordWebhook.url);
      hooks.push({ repository: input.backend, id: backHookId });

      const automationHooks: {
        frontendAutomationHookId?: number;
        backendAutomationHookId?: number;
      } = {};
      if (config.publicBaseUrl && config.githubWebhookSecret) {
        const endpoint = buildAutomationWebhookUrl(config.publicBaseUrl);
        automationHooks.frontendAutomationHookId = await github.createAutomationWebhook(
          input.frontend,
          endpoint,
          config.githubWebhookSecret,
        );
        automationHooks.backendAutomationHookId = await github.createAutomationWebhook(
          input.backend,
          endpoint,
          config.githubWebhookSecret,
        );
      }

      storedProject = await patchProject(storedProject, {
        frontendHookId: frontHookId,
        backendHookId: backHookId,
        ...automationHooks,
      });
      await frontendLog.send(`✅ GitHub 연결 · ${input.frontend.url}`).catch(() => undefined);
      await backendLog.send(`✅ GitHub 연결 · ${input.backend.url}`).catch(() => undefined);
    } catch (error) {
      warnings.add("github");
      console.warn(`GitHub 로그 자동 연결 실패 (${input.name})`, error);
      for (const hook of hooks.reverse()) {
        await github.deleteWebhook(hook.repository, hook.id).catch(() => undefined);
      }
    }

    let reviewReady = false;
    try {
      const reviewResults = await ensureProjectReviewWorkflows(github, storedProject);
      reviewReady = reviewResults.every((result) => !result.error);
      if (!reviewReady) {
        warnings.add("review_workflow");
        for (const result of reviewResults.filter((item) => item.error)) {
          console.warn(`Iseol review workflow 자동 설치 실패 (${result.repository}): ${result.error}`);
        }
      }
    } catch (error) {
      warnings.add("review_workflow");
      console.warn(`Iseol review workflow 자동 설치 실패 (${input.name})`, error);
    }

    await ensureProjectHub(overview, storedProject, projectHealth(storedProject, warnings, reviewReady))
      .catch((error) => console.warn(`프로젝트 허브 상태 갱신 실패 (${input.name})`, error));

    return { project: storedProject, warnings: [...warnings] };
  } catch (error) {
    if (!coreReady) {
      if (storedProject) await deleteProject(storedProject.id).catch(() => undefined);
      for (const id of [...createdChannelIds].reverse()) {
        await guild.channels.delete(id, "프로젝트 생성 실패 롤백").catch(() => undefined);
      }
      await category.delete("프로젝트 생성 실패 롤백").catch(() => undefined);
    }
    throw error;
  }
}

function warningLabel(warning: ProjectSetupWarning): string {
  if (warning === "github") return "GitHub 로그";
  if (warning === "notion") return "Notion";
  if (warning === "figma") return "Figma";
  if (warning === "calendar") return "Google Calendar";
  return "코드리뷰 workflow";
}

export async function handleProjectSetupModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  if (interaction.customId !== "project_setup_modal") return false;
  if (!interaction.guild) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const input = parseProjectSetupFields({
      name: interaction.fields.getTextInputValue("name"),
      frontend: interaction.fields.getTextInputValue("frontend"),
      backend: interaction.fields.getTextInputValue("backend"),
      notion: interaction.fields.getTextInputValue("notion"),
      figma: interaction.fields.getTextInputValue("figma"),
    });
    const result = await createProjectExperience(interaction.guild, input);
    const warningText = result.warnings.length
      ? `\n\n⚠️ 추가 설정 필요: ${result.warnings.map(warningLabel).join(", ")}\n프로젝트 자체는 생성되었고 허브에서 상태를 확인할 수 있습니다.`
      : "\n\n✅ 가능한 연동을 모두 자동 설정했습니다.";
    await interaction.editReply(`✅ **${result.project.name}** 프로젝트를 만들었습니다.${warningText}`);
  } catch (error) {
    console.error("프로젝트 자동 생성 실패", error);
    const message = error instanceof Error ? error.message : "프로젝트 생성 중 오류가 발생했습니다.";
    await interaction.editReply(`❌ 프로젝트를 만들지 못했습니다.\n${message}`);
  }
  return true;
}
