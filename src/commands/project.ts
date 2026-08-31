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
import { config } from "../config.js";`r`nimport { calendarPanel } from "../services/calendar/calendar-discord.js";`r`nimport { GoogleCalendarService } from "../services/calendar/google-calendar.js";
import { FigmaWebhookService, parseFigmaFile } from "../services/figma.js";
import { GitHubWebhookService, parseGitHubRepository, type RepositoryRef } from "../services/github.js";
import { NotionService, parseNotionPage } from "../services/notion.js";
import { deleteProject, listProjects, saveProject, updateProject } from "../services/projects.js";

export const projectCommand = new SlashCommandBuilder()
  .setName("project")
  .setDescription("?꾨줈?앺듃??Discord 梨꾨꼸怨??곕룞???먮룞 愿由ы빀?덈떎.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("?꾨줈?앺듃 怨듦컙??留뚮뱾怨?Notion/Figma/GitHub ?곕룞???먮룞 ?ㅼ젙?⑸땲??")
      .addStringOption((option) => option.setName("name").setDescription("?꾨줈?앺듃 ?대쫫 (2~50??").setMinLength(2).setMaxLength(50).setRequired(true))
      .addStringOption((option) => option.setName("notion").setDescription("?ㅼ젣 Notion 湲곕뒫紐낆꽭???섏씠吏 URL").setRequired(true))
      .addStringOption((option) => option.setName("figma").setDescription("?ㅼ젣 Figma ?뚯씪 URL (figma.com/design/...)").setRequired(true))
      .addStringOption((option) => option.setName("frontend").setDescription("https://github.com/ORG/frontend ?뺤떇").setRequired(true))
      .addStringOption((option) => option.setName("backend").setDescription("https://github.com/ORG/backend ?뺤떇").setRequired(true)),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("?앹꽦???꾨줈?앺듃 諛⑷낵 ?곌껐 ?뺣낫瑜???젣?⑸땲??")
      .addStringOption((option) => option
        .setName("name")
        .setDescription("??젣???꾨줈?앺듃 諛??좏깮")
        .setRequired(true)
        .setAutocomplete(true)),
  );

type GitHubHook = { repository: RepositoryRef; id: number };

async function createTextChannel(guild: Guild, parentId: string, name: string): Promise<TextChannel> {
  const channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId });
  if (!(channel instanceof TextChannel)) throw new Error(`${name} 梨꾨꼸???앹꽦?섏? 紐삵뻽?듬땲??`);
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
      await interaction.editReply("???댁꽕濡??앹꽦???꾨줈?앺듃 ?뺣낫瑜?李얠쓣 ???놁뒿?덈떎.");
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
        console.warn(`Frontend GitHub webhook ??젣 ?ㅽ뙣 (${project.name}):`, error);
        warnings.push("Frontend GitHub webhook");
      }
    }

    if (project.backendHookId !== undefined) {
      try {
        await github.deleteWebhook(project.backend, project.backendHookId);
      } catch (error) {
        console.warn(`Backend GitHub webhook ??젣 ?ㅽ뙣 (${project.name}):`, error);
        warnings.push("Backend GitHub webhook");
      }
    }

    if (project.figmaWebhookId) {
      try {
        await figmaWebhook.deleteWebhook(project.figmaWebhookId);
      } catch (error) {
        console.warn(`Figma webhook ??젣 ?ㅽ뙣 (${project.name}):`, error);
        warnings.push("Figma webhook");
      }
    }

    if (category) {
      const children = channels.filter((channel) => channel?.parentId === category.id);
      for (const channel of children.values()) {
        if (channel) {
          await channel.delete(`${project.name} ?꾨줈?앺듃 諛???젣`);
        }
      }
      await category.delete(`${project.name} ?꾨줈?앺듃 諛???젣`);
    }

    const deleted = await deleteProject(project.id);
    if (!deleted) throw new Error("?꾨줈?앺듃 ????뺣낫瑜???젣?섏? 紐삵뻽?듬땲??");

    const warningText = warnings.length > 0
      ? `\n?좑툘 ?몃? ?곕룞 ?뺣━ ?ㅽ뙣: ${warnings.join(", ")} (?쒕쾭 濡쒓렇 ?뺤씤)`
      : "";
    await interaction.editReply(`??**${project.name}** ?꾨줈?앺듃 諛⑷낵 ????뺣낫瑜???젣?덉뒿?덈떎.${warningText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "?????녿뒗 ?ㅻ쪟媛 諛쒖깮?덉뒿?덈떎.";
    await interaction.editReply(`???꾨줈?앺듃 諛???젣???ㅽ뙣?덉뒿?덈떎.\n\`${message}\``);
  }
}

export async function handleProjectCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: "?쒕쾭 ?덉뿉?쒕쭔 ?ъ슜?????덉뒿?덈떎." });
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
      throw new Error("Frontend? Backend ??μ냼??媛숈? GitHub Organization ?꾨옒???덉뼱???⑸땲??");
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
      throw new Error("Frontend? Backend ??μ냼??媛숈? GitHub Organization ?꾨옒???덉뼱???⑸땲??");
    }

    if (frontendOwner.type !== "Organization" || backendOwner.type !== "Organization") {
      throw new Error(`GitHub owner "${frontendOwner.login}"媛 Organization???꾨떃?덈떎.`);
    }

    const organization = frontendOwner.login;
    const category = await interaction.guild.channels.create({ name: `?뱚 ${name}`, type: ChannelType.GuildCategory });
    const createdChannelIds: string[] = [];
    const githubHooks: GitHubHook[] = [];
    let figmaWebhookId: string | null = null;
    let storedProjectId: string | null = null;`r`n    let calendarId: string | null = null;`r`n    let calendarUrl: string | undefined;

    try {
      const overview = await createTextChannel(interaction.guild, category.id, "?뱦?삵봽濡쒖젥??);
      const spec = await createTextChannel(interaction.guild, category.id, "?뱞?산린?λ챸?몄꽌");
      const figma = await createTextChannel(interaction.guild, category.id, "?렓?팭igma");
      const frontendLog = await createTextChannel(interaction.guild, category.id, "?뮲?팭rontend-log");
      const backendLog = await createTextChannel(interaction.guild, category.id, "?썱?팦ackend-log");
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

      const calendarMessage = await calendarChannel.send(calendarPanel(storedProject.id, calendarUrl));
      await calendarMessage.pin();
      await updateProject(storedProject.id, { calendarPanelMessageId: calendarMessage.id });

      const joinRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`project_join:${storedProject.id}`).setLabel("GitHub Organization 李몄뿬").setEmoji("??").setStyle(ButtonStyle.Primary),
      );

      const overviewMessage = await overview.send({
        content: "@everyone",
        allowedMentions: { parse: ["everyone"] },
        embeds: [new EmbedBuilder().setTitle(name).setDescription("?꾨줈?앺듃 臾몄꽌? 媛쒕컻 ??μ냼瑜??쒓납?먯꽌 愿由ы빀?덈떎.\n\n??먯? ?꾨옒 踰꾪듉?쇰줈 GitHub Organization 珥덈?瑜??붿껌?????덉뒿?덈떎.").addFields(
          { name: "湲곕뒫紐낆꽭??, value: notionPage.url },
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
          .setTitle("?뱞 湲곕뒫紐낆꽭??)
          .setDescription("Notion?먯꽌 ?꾨줈?앺듃 湲곕뒫紐낆꽭?쒕? ?뺤씤?⑸땲??\n\n?섏씠吏媛 ?섏젙?섎㈃ ??梨꾨꼸??蹂寃??뚮┝??湲곕줉?⑸땲??")
          .setURL(notionPage.url)],
        components: [linkButton("Notion ?닿린", notionPage.url)],
      });
      await specMessage.pin();
      const figmaMessage = await figma.send({
        embeds: [new EmbedBuilder()
          .setTitle("?렓 Figma")
          .setDescription("?꾨줈?앺듃 UI/UX ?붿옄?몄쓣 ?뺤씤?⑸땲??\n\nFigma?먯꽌 ?대쫫 ?덈뒗 踰꾩쟾???앹꽦?섍굅?????볤?/?듦????묒꽦?섎㈃ ??梨꾨꼸???뚮┝??湲곕줉?⑸땲??")
          .setURL(figmaFile.url)],
        components: [linkButton("Figma ?닿린", figmaFile.url)],
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

      await frontendLog.send({ embeds: [new EmbedBuilder().setTitle("??Frontend GitHub ?곌껐 ?꾨즺").setDescription(frontendRepo.url).setURL(frontendRepo.url)] });
      await backendLog.send({ embeds: [new EmbedBuilder().setTitle("??Backend GitHub ?곌껐 ?꾨즺").setDescription(backendRepo.url).setURL(backendRepo.url)] });
      await interaction.editReply(`??**${name}** ?꾨줈?앺듃 ?앹꽦 + Notion ?섏젙 ?뚮┝ + Figma 踰꾩쟾/?볤? ?뚮┝ + GitHub 濡쒓렇 + Organization 李몄뿬 踰꾪듉源뚯? ?꾨즺?덉뒿?덈떎.`);
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
        try { await interaction.guild.channels.delete(id, "?꾨줈?앺듃 ?앹꽦 ?ㅽ뙣 濡ㅻ갚"); } catch {}
      }
      try { await category.delete("?꾨줈?앺듃 ?앹꽦 ?ㅽ뙣 濡ㅻ갚"); } catch {}
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "?????녿뒗 ?ㅻ쪟媛 諛쒖깮?덉뒿?덈떎.";
    await interaction.editReply(`???꾨줈?앺듃 ?앹꽦???ㅽ뙣?덉뒿?덈떎.\n\`${message}\``);
  }
}
