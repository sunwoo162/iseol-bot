import {
  ActionRowBuilder,
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
import { GitHubWebhookService, parseGitHubRepository, type RepositoryRef } from "../services/github.js";
import { deleteProject, saveProject, updateProject } from "../services/projects.js";

export const projectCommand = new SlashCommandBuilder()
  .setName("project")
  .setDescription("프로젝트용 Discord 채널과 연동을 자동 관리합니다.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("새 프로젝트 공간을 생성합니다.")
      .addStringOption((option) => option.setName("name").setDescription("프로젝트 이름 (2~50자)").setMinLength(2).setMaxLength(50).setRequired(true))
      .addStringOption((option) => option.setName("notion").setDescription("실제 Notion 페이지 URL (notion.so / notion.site)").setRequired(true))
      .addStringOption((option) => option.setName("figma").setDescription("실제 Figma 파일 URL (figma.com/design/...)").setRequired(true))
      .addStringOption((option) => option.setName("frontend").setDescription("https://github.com/ORG/frontend 형식").setRequired(true))
      .addStringOption((option) => option.setName("backend").setDescription("https://github.com/ORG/backend 형식").setRequired(true)),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("생성된 프로젝트 방을 삭제합니다.")
      .addStringOption((option) => option.setName("name").setDescription("삭제할 프로젝트 방 이름").setMinLength(2).setMaxLength(100).setRequired(true)),
  );

type GitHubHook = { repository: RepositoryRef; id: number };

function parseHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error(`${label} 링크 형식이 올바르지 않습니다.`); }
  if (url.protocol !== "https:") throw new Error(`${label} 링크는 https:// 로 시작해야 합니다.`);
  return url;
}

function validateNotionUrl(value: string): string {
  const url = parseHttpsUrl(value, "Notion");
  const host = url.hostname.toLowerCase();
  const valid = host === "notion.so" || host === "www.notion.so" || host === "notion.site" || host.endsWith(".notion.site");
  if (!valid) throw new Error("Notion 링크는 https://www.notion.so/... 또는 https://xxxx.notion.site/... 형식만 사용할 수 있습니다.");
  if (url.pathname === "/" || url.pathname.length < 5) throw new Error("Notion 메인 주소가 아니라 실제 기능명세서 페이지 링크를 입력해주세요.");
  return url.toString();
}

function validateFigmaUrl(value: string): string {
  const url = parseHttpsUrl(value, "Figma");
  const host = url.hostname.toLowerCase();
  if (host !== "figma.com" && host !== "www.figma.com") throw new Error("Figma 링크는 https://www.figma.com/... 형식만 사용할 수 있습니다.");
  if (!["/design/", "/file/", "/board/", "/proto/"].some((prefix) => url.pathname.startsWith(prefix))) {
    throw new Error("Figma 메인 주소가 아니라 실제 디자인 파일 링크를 입력해주세요. 예: https://www.figma.com/design/...");
  }
  return url.toString();
}

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

async function handleDeleteProject(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;

  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getString("name", true).trim();

  try {
    const channels = await interaction.guild.channels.fetch();
    const selectedById = channels.get(target);
    const category = selectedById?.type === ChannelType.GuildCategory
      ? selectedById
      : channels.find((channel) =>
          channel?.type === ChannelType.GuildCategory
          && projectNameFromCategory(channel.name).toLowerCase() === target.toLowerCase(),
        );

    if (!category) {
      await interaction.editReply(`❌ **${target}** 프로젝트 방을 찾을 수 없습니다.`);
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
    await interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "delete") {
    await handleDeleteProject(interaction);
    return;
  }
  if (subcommand !== "create") return;

  await interaction.deferReply({ ephemeral: true });
  const name = interaction.options.getString("name", true).trim();

  try {
    const notionUrl = validateNotionUrl(interaction.options.getString("notion", true));
    const figmaUrl = validateFigmaUrl(interaction.options.getString("figma", true));
    const frontendRepo = parseGitHubRepository(interaction.options.getString("frontend", true));
    const backendRepo = parseGitHubRepository(interaction.options.getString("backend", true));

    if (frontendRepo.owner.toLowerCase() !== backendRepo.owner.toLowerCase()) {
      throw new Error("Frontend와 Backend 저장소는 같은 GitHub Organization 아래에 있어야 합니다.");
    }

    const github = new GitHubWebhookService(config.githubToken);
    const [frontendOwner, backendOwner] = await Promise.all([
      github.getRepositoryOwner(frontendRepo),
      github.getRepositoryOwner(backendRepo),
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
      });
      storedProjectId = storedProject.id;

      const joinRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`project_join:${storedProject.id}`).setLabel("GitHub Organization 참여").setEmoji("🚀").setStyle(ButtonStyle.Primary),
      );

      const overviewMessage = await overview.send({
        embeds: [new EmbedBuilder().setTitle(name).setDescription("프로젝트 문서와 개발 저장소를 한곳에서 관리합니다.\n\n팀원은 아래 버튼으로 GitHub Organization 초대를 요청할 수 있습니다.").addFields(
          { name: "기능명세서", value: notionUrl },
          { name: "Figma", value: figmaUrl },
          { name: "GitHub Organization", value: `https://github.com/${organization}` },
          { name: "Frontend", value: frontendRepo.url },
          { name: "Backend", value: backendRepo.url },
        )],
        components: [joinRow],
      });
      await overviewMessage.pin();

      const specMessage = await spec.send({ embeds: [new EmbedBuilder().setTitle("📄 기능명세서").setDescription("Notion에서 프로젝트 기능명세서를 확인합니다.").setURL(notionUrl)], components: [linkButton("Notion 열기", notionUrl)] });
      await specMessage.pin();
      const figmaMessage = await figma.send({ embeds: [new EmbedBuilder().setTitle("🎨 Figma").setDescription("프로젝트 UI/UX 디자인을 확인합니다.").setURL(figmaUrl)], components: [linkButton("Figma 열기", figmaUrl)] });
      await figmaMessage.pin();

      const frontDiscordWebhook = await frontendLog.createWebhook({ name: `${name} Frontend Log`, reason: `${name} frontend GitHub integration` });
      const backDiscordWebhook = await backendLog.createWebhook({ name: `${name} Backend Log`, reason: `${name} backend GitHub integration` });

      const frontHookId = await github.createDiscordWebhook(frontendRepo, frontDiscordWebhook.url);
      githubHooks.push({ repository: frontendRepo, id: frontHookId });
      const backHookId = await github.createDiscordWebhook(backendRepo, backDiscordWebhook.url);
      githubHooks.push({ repository: backendRepo, id: backHookId });

      await updateProject(storedProject.id, { frontendHookId: frontHookId, backendHookId: backHookId });

      await frontendLog.send({ embeds: [new EmbedBuilder().setTitle("✅ Frontend GitHub 연결 완료").setDescription(frontendRepo.url).setURL(frontendRepo.url)] });
      await backendLog.send({ embeds: [new EmbedBuilder().setTitle("✅ Backend GitHub 연결 완료").setDescription(backendRepo.url).setURL(backendRepo.url)] });
      await interaction.editReply(`✅ **${name}** 프로젝트 생성 + Notion/Figma 검증 + GitHub 로그 + Organization 참여 버튼까지 완료했습니다.`);
    } catch (error) {
      for (const hook of githubHooks.reverse()) {
        try { await github.deleteWebhook(hook.repository, hook.id); } catch {}
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
