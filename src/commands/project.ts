import {
  ActionRowBuilder,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
} from "discord.js";
import { config } from "../config.js";
import { calendarPanel } from "../services/calendar/calendar-discord.js";
import { CalendarStateStore } from "../services/calendar/calendar-state.js";
import { GoogleCalendarService } from "../services/calendar/google-calendar.js";
import { FigmaWebhookService, parseFigmaFile } from "../services/figma.js";
import { buildAutomationWebhookUrl, GitHubWebhookService, parseGitHubRepository, type RepositoryRef } from "../services/github.js";
import { NotionService, parseNotionPage } from "../services/notion.js";
import { deleteProject, listProjects, saveProject, updateProject } from "../services/projects.js";

export const projectCommand = new SlashCommandBuilder()
  .setName("project")
  .setDescription("프로젝트용 Discord 채널과 연동을 자동 관리합니다.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("프로젝트 공간을 만들고 Notion/Figma/GitHub 연동을 자동 설정합니다.")
      .addStringOption((option) => option.setName("name").setDescription("프로젝트 이름 (2~50자)").setMinLength(2).setMaxLength(50).setRequired(true))
      .addStringOption((option) => option.setName("notion").setDescription("실제 Notion 기능명세서 페이지 URL").setRequired(true))
      .addStringOption((option) => option.setName("figma").setDescription("실제 Figma 파일 URL (figma.com/design/...)").setRequired(true))
      .addStringOption((option) => option.setName("frontend").setDescription("https://github.com/ORG/frontend 형식").setRequired(true))
      .addStringOption((option) => option.setName("backend").setDescription("https://github.com/ORG/backend 형식").setRequired(true)),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("생성된 프로젝트 방과 연결 정보를 삭제합니다.")
      .addStringOption((option) => option
        .setName("name")
        .setDescription("삭제할 프로젝트 방 선택")
        .setRequired(true)
        .setAutocomplete(true)),
  );

type GitHubHook = { repository: RepositoryRef; id: number };

async function createTextChannel(guild: Guild, parentId: string, name: string): Promise<TextChannel> {
  const channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId });
  if (!(channel instanceof TextChannel)) throw new Error(`${name} 채널을 생성하지 못했습니다.`);
  return channel;
}

function linkButton(label: string, url: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url));
}

export async function handleProjectAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild || interaction.commandName !== "project") return;

  let subcommand: string;
  try {
    subcommand = interaction.options.getSubcommand();
  } catch {
    return;
  }

  if (subcommand !== "delete") return;

  const focused = interaction.options.getFocused().toString().trim().toLowerCase();
  const projects = (await listProjects()).filter((project) => project.guildId === interaction.guild!.id);
  const choices = projects
    .filter((project) => !focused || project.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((project) => ({
      name: project.name.slice(0, 100),
      value: project.categoryId,
    }));

  await interaction.respond(choices);
}

async function resolveProjectCategory(interaction: ChatInputCommandInteraction, target: string) {
  if (!interaction.guild) return null;

  const normalizedTarget = target.trim().toLowerCase();
  const projects = (await listProjects()).filter((project) => project.guildId === interaction.guild!.id);
  const project = projects.find((item) =>
    item.categoryId === target || item.name.trim().toLowerCase() === normalizedTarget,
  ) ?? null;

  const channels = await interaction.guild.channels.fetch();
  const selected = project ? channels.get(project.categoryId) : null;
  const category = selected?.type === ChannelType.GuildCategory ? selected : null;

  return { channels, category, project };
}

async function handleDeleteProject(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;

  await interaction.deferReply();
  const target = interaction.options.getString("name", true).trim();

  try {
    const resolved = await resolveProjectCategory(interaction, target);
    const project = resolved?.project;
    const category = resolved?.category;
    const channels = resolved?.channels;

    if (!project || !channels) {
      await interaction.editReply("❌ 이설로 생성한 프로젝트 정보를 찾을 수 없습니다.");
      return;
    }

    const warnings: string[] = [];
    const github = new GitHubWebhookService(config.githubToken);
    const figmaWebhook = new FigmaWebhookService(
      config.figmaToken,
      config.publicBaseUrl,
      config.figmaWebhookPasscode,
    );

    if (project.frontendHookId !== undefined) {
      try {
        await github.deleteWebhook(project.frontend, project.frontendHookId);
      } catch (error) {
        console.warn(`Frontend GitHub webhook 삭제 실패 (${project.name}):`, error);
        warnings.push("Frontend GitHub webhook");
      }
    }

    if (project.backendHookId !== undefined) {
      try {
        await github.deleteWebhook(project.backend, project.backendHookId);
      } catch (error) {
        console.warn(`Backend GitHub webhook 삭제 실패 (${project.name}):`, error);
        warnings.push("Backend GitHub webhook");
      }
    }

    if (project.frontendAutomationHookId !== undefined) {
      try {
        await github.deleteWebhook(project.frontend, project.frontendAutomationHookId);
      } catch (error) {
        console.warn(`Frontend automation webhook 삭제 실패 (${project.name}):`, error);
        warnings.push("Frontend automation webhook");
      }
    }

    if (project.backendAutomationHookId !== undefined) {
      try {
        await github.deleteWebhook(project.backend, project.backendAutomationHookId);
      } catch (error) {
        console.warn(`Backend automation webhook 삭제 실패 (${project.name}):`, error);
        warnings.push("Backend automation webhook");
      }
    }

    if (project.figmaWebhookId) {
      try {
        await figmaWebhook.deleteWebhook(project.figmaWebhookId);
      } catch (error) {
        console.warn(`Figma webhook 삭제 실패 (${project.name}):`, error);
        warnings.push("Figma webhook");
      }
    }

    if (project.calendarId) {
      if (config.googleClientId && config.googleClientSecret && config.googleRefreshToken) {
        try {
          await new GoogleCalendarService(config.googleClientId, config.googleClientSecret, config.googleRefreshToken, config.googleRedirectUri)
            .deleteProjectCalendar(project.calendarId);
          await new CalendarStateStore().removeProject(project.id);
        } catch (error) {
          console.warn(`Google Calendar 삭제 실패 (${project.name}):`, error);
          warnings.push("Google Calendar");
        }
      } else {
        warnings.push("Google Calendar credentials missing");
      }
    }

    if (category) {
      const children = channels.filter((channel) => channel?.parentId === category.id);
      for (const channel of children.values()) {
        if (channel) {
          await channel.delete(`${project.name} 프로젝트 방 삭제`);
        }
      }
      await category.delete(`${project.name} 프로젝트 방 삭제`);
    }

    const deleted = await deleteProject(project.id);
    if (!deleted) throw new Error("프로젝트 저장 정보를 삭제하지 못했습니다.");

    const warningText = warnings.length > 0
      ? `\n⚠️ 외부 연동 정리 실패: ${warnings.join(", ")} (서버 로그 확인)`
      : "";
    await interaction.editReply(`✅ **${project.name}** 프로젝트 방과 저장 정보를 삭제했습니다.${warningText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    await interaction.editReply(`❌ 프로젝트 방 삭제에 실패했습니다.\n\`${message}\``);
  }
}

export async function handleProjectCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있습니다." });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "delete") {
    await handleDeleteProject(interaction);
    return;
  }
  if (subcommand !== "create") return;

  await interaction.deferReply();
  const name = interaction.options.getString("name", true).trim();

  try {
    const notionPage = parseNotionPage(interaction.options.getString("notion", true));
    const figmaFile = parseFigmaFile(interaction.options.getString("figma", true));
    const frontendRepo = parseGitHubRepository(interaction.options.getString("frontend", true));
    const backendRepo = parseGitHubRepository(interaction.options.getString("backend", true));

    if (frontendRepo.owner.toLowerCase() !== backendRepo.owner.toLowerCase()) {
      throw new Error("Frontend와 Backend 저장소는 같은 GitHub Organization 아래에 있어야 합니다.");
    }

    const github = new GitHubWebhookService(config.githubToken);
    const notion = new NotionService(config.notionToken);
    const figmaWebhook = new FigmaWebhookService(
      config.figmaToken,
      config.publicBaseUrl,
      config.figmaWebhookPasscode,
    );
    const [frontendOwner, backendOwner, notionSnapshot] = await Promise.all([
      github.getRepositoryOwner(frontendRepo),
      github.getRepositoryOwner(backendRepo),
      notion.getPage(notionPage.id),
    ]);

    if (frontendOwner.login.toLowerCase() !== backendOwner.login.toLowerCase()) {
      throw new Error("Frontend와 Backend 저장소는 같은 GitHub Organization 아래에 있어야 합니다.");
    }

    if (frontendOwner.type !== "Organization" || backendOwner.type !== "Organization") {
      throw new Error(`GitHub owner "${frontendOwner.login}"가 Organization이 아닙니다.`);
    }

    const organization = frontendOwner.login;
    const category = await interaction.guild.channels.create({ name: `📁 ${name}`, type: ChannelType.GuildCategory });
    const createdChannelIds: string[] = [];
    const githubHooks: GitHubHook[] = [];
    let figmaWebhookId: string | null = null;
    let storedProjectId: string | null = null;
    let calendarId: string | null = null;
    let calendarUrl: string | undefined;

    try {
      const overview = await createTextChannel(interaction.guild, category.id, "📌・프로젝트");
      const spec = await createTextChannel(interaction.guild, category.id, "📄・기능명세서");
      const figma = await createTextChannel(interaction.guild, category.id, "🎨・figma");
      const frontendLog = await createTextChannel(interaction.guild, category.id, "💻・frontend-log");
      const backendLog = await createTextChannel(interaction.guild, category.id, "🛠・backend-log");
      const calendarChannel = await createTextChannel(interaction.guild, category.id, "📅・일정");
      createdChannelIds.push(overview.id, spec.id, figma.id, frontendLog.id, backendLog.id, calendarChannel.id);

      if (config.googleClientId && config.googleClientSecret && config.googleRefreshToken) {
        const createdCalendar = await new GoogleCalendarService(
          config.googleClientId, config.googleClientSecret, config.googleRefreshToken, config.googleRedirectUri,
        ).createProjectCalendar(name);
        calendarId = createdCalendar.id;
        calendarUrl = createdCalendar.url;
      }

      const storedProject = await saveProject({
        name,
        guildId: interaction.guild.id,
        categoryId: category.id,
        organization,
        frontend: frontendRepo,
        backend: backendRepo,
        frontendLogChannelId: frontendLog.id,
        backendLogChannelId: backendLog.id,
        calendarId: calendarId ?? undefined,
        calendarUrl,
        calendarChannelId: calendarChannel.id,
        figmaUrl: figmaFile.url,
        figmaFileKey: figmaFile.key,
        figmaChannelId: figma.id,
        notionUrl: notionPage.url,
        notionPageId: notionPage.id,
        notionChannelId: spec.id,
        notionLastEditedTime: notionSnapshot.last_edited_time,
      });
      storedProjectId = storedProject.id;

      const calendarMessage = await calendarChannel.send(calendarPanel(storedProject.id, calendarUrl));
      await calendarMessage.pin();
      await updateProject(storedProject.id, { calendarPanelMessageId: calendarMessage.id });

      const joinRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`project_join:${storedProject.id}`).setLabel("GitHub Organization 참여").setEmoji("🚀").setStyle(ButtonStyle.Primary),
      );

      const overviewMessage = await overview.send({
        content: "@everyone",
        allowedMentions: { parse: ["everyone"] },
        embeds: [new EmbedBuilder().setTitle(name).setDescription("프로젝트 문서와 개발 저장소를 한곳에서 관리합니다.\n\n팀원은 아래 버튼으로 GitHub Organization 초대를 요청할 수 있습니다.").addFields(
          { name: "기능명세서", value: notionPage.url },
          { name: "Figma", value: figmaFile.url },
          { name: "GitHub Organization", value: `https://github.com/${organization}` },
          { name: "Frontend", value: frontendRepo.url },
          { name: "Backend", value: backendRepo.url },
        )],
        components: [joinRow],
      });
      await overviewMessage.pin();

      const specMessage = await spec.send({
        embeds: [new EmbedBuilder()
          .setTitle("📄 기능명세서")
          .setDescription("Notion에서 프로젝트 기능명세서를 확인합니다.\n\n페이지가 수정되면 이 채널에 변경 알림이 기록됩니다.")
          .setURL(notionPage.url)],
        components: [linkButton("Notion 열기", notionPage.url)],
      });
      await specMessage.pin();
      const figmaMessage = await figma.send({
        embeds: [new EmbedBuilder()
          .setTitle("🎨 Figma")
          .setDescription("프로젝트 UI/UX 디자인을 확인합니다.\n\nFigma에서 이름 있는 버전을 생성하거나 새 댓글/답글을 작성하면 이 채널에 알림이 기록됩니다.")
          .setURL(figmaFile.url)],
        components: [linkButton("Figma 열기", figmaFile.url)],
      });
      await figmaMessage.pin();

      const existingComments = await figmaWebhook.listComments(figmaFile.key);
      figmaWebhookId = await figmaWebhook.createVersionWebhook(figmaFile.key, `${name} named version notifications`);
      await updateProject(storedProject.id, {
        figmaWebhookId,
        figmaLastVersionId: figmaWebhookId,
        figmaKnownCommentIds: existingComments.map((comment) => comment.id),
      });

      const frontDiscordWebhook = await frontendLog.createWebhook({ name: `${name} Frontend Log`, reason: `${name} frontend GitHub integration` });
      const backDiscordWebhook = await backendLog.createWebhook({ name: `${name} Backend Log`, reason: `${name} backend GitHub integration` });

      const frontHookId = await github.createDiscordWebhook(frontendRepo, frontDiscordWebhook.url);
      githubHooks.push({ repository: frontendRepo, id: frontHookId });
      const backHookId = await github.createDiscordWebhook(backendRepo, backDiscordWebhook.url);
      githubHooks.push({ repository: backendRepo, id: backHookId });

      const automationHooks: { frontendAutomationHookId?: number; backendAutomationHookId?: number } = {};
      if (config.publicBaseUrl && config.githubWebhookSecret) {
        const endpoint = buildAutomationWebhookUrl(config.publicBaseUrl);
        const frontAutomationHookId = await github.createAutomationWebhook(frontendRepo, endpoint, config.githubWebhookSecret);
        githubHooks.push({ repository: frontendRepo, id: frontAutomationHookId });
        const backAutomationHookId = await github.createAutomationWebhook(backendRepo, endpoint, config.githubWebhookSecret);
        githubHooks.push({ repository: backendRepo, id: backAutomationHookId });
        automationHooks.frontendAutomationHookId = frontAutomationHookId;
        automationHooks.backendAutomationHookId = backAutomationHookId;
      }

      await updateProject(storedProject.id, { frontendHookId: frontHookId, backendHookId: backHookId, ...automationHooks });

      await frontendLog.send({ embeds: [new EmbedBuilder().setTitle("✅ Frontend GitHub 연결 완료").setDescription(frontendRepo.url).setURL(frontendRepo.url)] });
      await backendLog.send({ embeds: [new EmbedBuilder().setTitle("✅ Backend GitHub 연결 완료").setDescription(backendRepo.url).setURL(backendRepo.url)] });
      await interaction.editReply(`✅ **${name}** 프로젝트 생성 + Notion 수정 알림 + Figma 버전/댓글 알림 + GitHub 로그 + 프로젝트 일정 + Organization 참여 버튼까지 완료했습니다.`);
    } catch (error) {
      for (const hook of githubHooks.reverse()) {
        try { await github.deleteWebhook(hook.repository, hook.id); } catch {}
      }
      if (figmaWebhookId) {
        try { await figmaWebhook.deleteWebhook(figmaWebhookId); } catch {}
      }
      if (storedProjectId) {
        try { await deleteProject(storedProjectId); } catch {}
      }
      if (calendarId && config.googleClientId && config.googleClientSecret && config.googleRefreshToken) {
        try {
          await new GoogleCalendarService(config.googleClientId, config.googleClientSecret, config.googleRefreshToken, config.googleRedirectUri)
            .deleteProjectCalendar(calendarId);
        } catch {}
      }
      for (const id of createdChannelIds) {
        try { await interaction.guild.channels.delete(id, "프로젝트 생성 실패 롤백"); } catch {}
      }
      try { await category.delete("프로젝트 생성 실패 롤백"); } catch {}
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    await interaction.editReply(`❌ 프로젝트 생성에 실패했습니다.\n\`${message}\``);
  }
}
