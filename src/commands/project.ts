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
import { FigmaWebhookService, parseFigmaFile } from "../services/figma.js";
import { GitHubWebhookService, parseGitHubRepository, type RepositoryRef } from "../services/github.js";
import { NotionService, parseNotionPage } from "../services/notion.js";
import { deleteProject, findProjectByName, saveProject, updateProject } from "../services/projects.js";

export const projectCommand = new SlashCommandBuilder()
  .setName("project")
  .setDescription("프로젝트용 Discord 채널과 연동을 자동 관리합니다.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("새 프로젝트 공간을 생성합니다.")
      .addStringOption((option) => option.setName("name").setDescription("프로젝트 이름 (2~50자)").setMinLength(2).setMaxLength(50).setRequired(true))
      .addStringOption((option) => option.setName("notion").setDescription("실제 Notion 기능명세서 페이지 URL").setRequired(true))
      .addStringOption((option) => option.setName("figma").setDescription("실제 Figma 파일 URL (figma.com/design/...)").setRequired(true))
      .addStringOption((option) => option.setName("frontend").setDescription("https://github.com/ORG/frontend 형식").setRequired(true))
      .addStringOption((option) => option.setName("backend").setDescription("https://github.com/ORG/backend 형식").setRequired(true)),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("notion-connect")
      .setDescription("기존 프로젝트에 Notion 기능명세서 수정 알림을 연결합니다.")
      .addStringOption((option) => option
        .setName("name")
        .setDescription("연결할 프로젝트 방 선택")
        .setRequired(true)
        .setAutocomplete(true))
      .addStringOption((option) => option
        .setName("notion")
        .setDescription("연결할 실제 Notion 기능명세서 페이지 URL")
        .setRequired(true)),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("figma-connect")
      .setDescription("기존 프로젝트에 Figma 이름 있는 버전 알림을 연결합니다.")
      .addStringOption((option) => option
        .setName("name")
        .setDescription("연결할 프로젝트 방 선택")
        .setRequired(true)
        .setAutocomplete(true))
      .addStringOption((option) => option
        .setName("figma")
        .setDescription("연결할 실제 Figma 파일 URL")
        .setRequired(true)),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("생성된 프로젝트 방을 삭제합니다.")
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

function projectNameFromCategory(name: string): string {
  return name.replace(/^📁\s*/, "").trim();
}

export async function handleProjectAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild || interaction.commandName !== "project") return;

  let subcommand: string;
  try {
    subcommand = interaction.options.getSubcommand();
  } catch {
    return;
  }

  if (subcommand !== "delete" && subcommand !== "figma-connect" && subcommand !== "notion-connect") return;

  const focused = interaction.options.getFocused().toString().trim().toLowerCase();
  const channels = await interaction.guild.channels.fetch();
  const choices = channels
    .filter((channel) => channel?.type === ChannelType.GuildCategory)
    .map((channel) => ({
      name: projectNameFromCategory(channel!.name),
      value: channel!.id,
    }))
    .filter((choice) => !focused || choice.name.toLowerCase().includes(focused))
    .slice(0, 25);

  await interaction.respond(choices);
}

async function resolveProjectCategory(interaction: ChatInputCommandInteraction, target: string) {
  if (!interaction.guild) return null;

  const channels = await interaction.guild.channels.fetch();
  const selectedById = channels.get(target);
  const category = selectedById?.type === ChannelType.GuildCategory
    ? selectedById
    : channels.find((channel) =>
        channel?.type === ChannelType.GuildCategory
        && projectNameFromCategory(channel.name).toLowerCase() === target.toLowerCase(),
      );

  return { channels, category };
}

async function handleNotionConnect(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;

  await interaction.deferReply();
  const target = interaction.options.getString("name", true).trim();

  try {
    const resolved = await resolveProjectCategory(interaction, target);
    const category = resolved?.category;
    const channels = resolved?.channels;

    if (!category || !channels) {
      await interaction.editReply("❌ 선택한 프로젝트 방을 찾을 수 없습니다.");
      return;
    }

    const projectName = projectNameFromCategory(category.name);
    const project = await findProjectByName(interaction.guild.id, projectName);
    if (!project) {
      await interaction.editReply("❌ 저장된 프로젝트 정보를 찾을 수 없습니다. 이설로 생성한 프로젝트인지 확인해주세요.");
      return;
    }

    const notionChannel = channels.find((channel) =>
      channel?.parentId === category.id
      && channel.type === ChannelType.GuildText
      && channel.name === "📄・기능명세서",
    );

    if (!(notionChannel instanceof TextChannel)) {
      await interaction.editReply("❌ 프로젝트의 📄・기능명세서 채널을 찾을 수 없습니다.");
      return;
    }

    const notionPage = parseNotionPage(interaction.options.getString("notion", true));
    const notion = new NotionService(config.notionToken);
    const page = await notion.getPage(notionPage.id);

    await updateProject(project.id, {
      notionUrl: notionPage.url,
      notionPageId: notionPage.id,
      notionChannelId: notionChannel.id,
      notionLastEditedTime: page.last_edited_time,
    });

    await notionChannel.send({
      embeds: [new EmbedBuilder()
        .setTitle("✅ Notion 수정 알림 연결 완료")
        .setDescription("이제 기능명세서 페이지가 수정되면 이 채널에 변경 알림이 기록됩니다.")
        .setURL(notionPage.url)],
      components: [linkButton("Notion 열기", notionPage.url)],
    });

    await interaction.editReply(`✅ **${projectName}** 프로젝트에 Notion 기능명세서 수정 알림을 연결했습니다.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    await interaction.editReply(`❌ Notion 알림 연결에 실패했습니다.\n\`${message}\``);
  }
}

async function handleFigmaConnect(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;

  await interaction.deferReply();
  const target = interaction.options.getString("name", true).trim();

  try {
    const resolved = await resolveProjectCategory(interaction, target);
    const category = resolved?.category;
    const channels = resolved?.channels;

    if (!category || !channels) {
      await interaction.editReply("❌ 선택한 프로젝트 방을 찾을 수 없습니다.");
      return;
    }

    const projectName = projectNameFromCategory(category.name);
    const project = await findProjectByName(interaction.guild.id, projectName);
    if (!project) {
      await interaction.editReply("❌ 저장된 프로젝트 정보를 찾을 수 없습니다. 이설로 생성한 프로젝트인지 확인해주세요.");
      return;
    }

    const figmaChannel = channels.find((channel) =>
      channel?.parentId === category.id
      && channel.type === ChannelType.GuildText
      && channel.name === "🎨・figma",
    );

    if (!(figmaChannel instanceof TextChannel)) {
      await interaction.editReply("❌ 프로젝트의 🎨・figma 채널을 찾을 수 없습니다.");
      return;
    }

    const figmaFile = parseFigmaFile(interaction.options.getString("figma", true));
    const figmaWebhook = new FigmaWebhookService(
      config.figmaToken,
      config.publicBaseUrl,
      config.figmaWebhookPasscode,
    );

    if (project.figmaWebhookId) {
      try {
        await figmaWebhook.deleteWebhook(project.figmaWebhookId);
      } catch (error) {
        console.warn(`기존 Figma Webhook 삭제 실패 (${project.name}):`, error);
      }
    }

    const [figmaWebhookId, existingComments] = await Promise.all([
      figmaWebhook.createVersionWebhook(
        figmaFile.key,
        `${projectName} named version notifications`,
      ),
      figmaWebhook.listComments(figmaFile.key),
    ]);

    await updateProject(project.id, {
      figmaUrl: figmaFile.url,
      figmaFileKey: figmaFile.key,
      figmaChannelId: figmaChannel.id,
      figmaWebhookId,
      figmaLastVersionId: figmaWebhookId,
      figmaKnownCommentIds: existingComments.map((comment) => comment.id),
    });

    await figmaChannel.send({
      embeds: [new EmbedBuilder()
        .setTitle("✅ Figma 알림 연결 완료")
        .setDescription("이제 Figma에서 이름 있는 버전을 생성하거나 새 댓글/답글을 작성하면 이 채널에 알림이 기록됩니다.")
        .setURL(figmaFile.url)],
      components: [linkButton("Figma 열기", figmaFile.url)],
    });

    await interaction.editReply(`✅ **${projectName}** 프로젝트에 Figma 버전/댓글 알림을 연결했습니다.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    await interaction.editReply(`❌ Figma 알림 연결에 실패했습니다.\n\`${message}\``);
  }
}

async function handleDeleteProject(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;

  await interaction.deferReply();
  const target = interaction.options.getString("name", true).trim();

  try {
    const resolved = await resolveProjectCategory(interaction, target);
    const category = resolved?.category;
    const channels = resolved?.channels;

    if (!category || !channels) {
      await interaction.editReply("❌ 선택한 프로젝트 방을 찾을 수 없습니다.");
      return;
    }

    const projectName = projectNameFromCategory(category.name);
    const children = channels.filter((channel) => channel?.parentId === category.id);

    for (const channel of children.values()) {
      if (channel) {
        await channel.delete(`${projectName} 프로젝트 방 삭제`);
      }
    }

    await category.delete(`${projectName} 프로젝트 방 삭제`);
    await interaction.editReply(`✅ **${projectName}** 프로젝트 방을 삭제했습니다.`);
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
  if (subcommand === "notion-connect") {
    await handleNotionConnect(interaction);
    return;
  }
  if (subcommand === "figma-connect") {
    await handleFigmaConnect(interaction);
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

    try {
      const overview = await createTextChannel(interaction.guild, category.id, "📌・프로젝트");
      const spec = await createTextChannel(interaction.guild, category.id, "📄・기능명세서");
      const figma = await createTextChannel(interaction.guild, category.id, "🎨・figma");
      const frontendLog = await createTextChannel(interaction.guild, category.id, "💻・frontend-log");
      const backendLog = await createTextChannel(interaction.guild, category.id, "🛠・backend-log");
      createdChannelIds.push(overview.id, spec.id, figma.id, frontendLog.id, backendLog.id);

      const storedProject = await saveProject({
        name,
        guildId: interaction.guild.id,
        categoryId: category.id,
        organization,
        frontend: frontendRepo,
        backend: backendRepo,
        figmaUrl: figmaFile.url,
        figmaFileKey: figmaFile.key,
        figmaChannelId: figma.id,
        notionUrl: notionPage.url,
        notionPageId: notionPage.id,
        notionChannelId: spec.id,
        notionLastEditedTime: notionSnapshot.last_edited_time,
      });
      storedProjectId = storedProject.id;

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

      await updateProject(storedProject.id, { frontendHookId: frontHookId, backendHookId: backHookId });

      await frontendLog.send({ embeds: [new EmbedBuilder().setTitle("✅ Frontend GitHub 연결 완료").setDescription(frontendRepo.url).setURL(frontendRepo.url)] });
      await backendLog.send({ embeds: [new EmbedBuilder().setTitle("✅ Backend GitHub 연결 완료").setDescription(backendRepo.url).setURL(backendRepo.url)] });
      await interaction.editReply(`✅ **${name}** 프로젝트 생성 + Notion 수정 알림 + Figma 버전/댓글 알림 + GitHub 로그 + Organization 참여 버튼까지 완료했습니다.`);
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
