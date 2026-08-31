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
import { config } from "../config.js";`r`nimport { calendarPanel } from "../services/calendar/calendar-discord.js";
import { CalendarStateStore } from "../services/calendar/calendar-state.js";`r`nimport { GoogleCalendarService } from "../services/calendar/google-calendar.js";
import { FigmaWebhookService, parseFigmaFile } from "../services/figma.js";
import { buildAutomationWebhookUrl, GitHubWebhookService, parseGitHubRepository, type RepositoryRef } from "../services/github.js";
import { NotionService, parseNotionPage } from "../services/notion.js";
import { deleteProject, listProjects, saveProject, updateProject } from "../services/projects.js";

export const projectCommand = new SlashCommandBuilder()
  .setName("project")
  .setDescription("?熬곣뫁夷??釉띾콦??Discord 嶺??х몭硫㈑???⑤베吏?????吏???㉱?洹먮뿫????덈펲.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("?熬곣뫁夷??釉띾콦 ??ㅻ????嶺뚮씭??キ?뤒?Notion/Figma/GitHub ??⑤베吏?????吏????깆젧??紐껊퉵??")
      .addStringOption((option) => option.setName("name").setDescription("?熬곣뫁夷??釉띾콦 ???藥?(2~50??").setMinLength(2).setMaxLength(50).setRequired(true))
      .addStringOption((option) => option.setName("notion").setDescription("???깆젷 Notion ?リ옇????춻??얠돪????瑜곷턄嶺뚯솘? URL").setRequired(true))
      .addStringOption((option) => option.setName("figma").setDescription("???깆젷 Figma ???逾?URL (figma.com/design/...)").setRequired(true))
      .addStringOption((option) => option.setName("frontend").setDescription("https://github.com/ORG/frontend ?筌먦끇六?).setRequired(true))
      .addStringOption((option) => option.setName("backend").setDescription("https://github.com/ORG/backend ?筌먦끇六?).setRequired(true)),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("??諛댁뎽???熬곣뫁夷??釉띾콦 ?꾩렮維????⑤슡???筌먲퐢沅???????紐껊퉵??")
      .addStringOption((option) => option
        .setName("name")
        .setDescription("??????熬곣뫁夷??釉띾콦 ????ルㅎ臾?)
        .setRequired(true)
        .setAutocomplete(true)),
  );

type GitHubHook = { repository: RepositoryRef; id: number };

async function createTextChannel(guild: Guild, parentId: string, name: string): Promise<TextChannel> {
  const channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId });
  if (!(channel instanceof TextChannel)) throw new Error(`${name} 嶺??х몭????諛댁뎽??? 嶺뚮쪇沅?쭛???鍮??`);
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
      await interaction.editReply("????怨댄맟????諛댁뎽???熬곣뫁夷??釉띾콦 ?筌먲퐢沅??嶺뚢돦堉??????怨룸????덈펲.");
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
        console.warn(`Frontend GitHub webhook ???????덉넮 (${project.name}):`, error);
        warnings.push("Frontend GitHub webhook");
      }
    }

    if (project.frontendAutomationHookId !== undefined) {
      try { await github.deleteWebhook(project.frontend, project.frontendAutomationHookId); }
      catch (error) { console.warn(`Frontend automation webhook ??젣 ?ㅽ뙣 (${project.name}):`, error); warnings.push("Frontend automation webhook"); }
    }

    if (project.backendAutomationHookId !== undefined) {
      try { await github.deleteWebhook(project.backend, project.backendAutomationHookId); }
      catch (error) { console.warn(`Backend automation webhook ??젣 ?ㅽ뙣 (${project.name}):`, error); warnings.push("Backend automation webhook"); }
    }
    if (project.backendHookId !== undefined) {
      try {
        await github.deleteWebhook(project.backend, project.backendHookId);
      } catch (error) {
        console.warn(`Backend GitHub webhook ???????덉넮 (${project.name}):`, error);
        warnings.push("Backend GitHub webhook");
      }
    }

    if (project.figmaWebhookId) {
      try {
        await figmaWebhook.deleteWebhook(project.figmaWebhookId);
      } catch (error) {
        console.warn(`Figma webhook ???????덉넮 (${project.name}):`, error);
        warnings.push("Figma webhook");
      }
    }

    if (project.calendarId && config.googleClientId && config.googleClientSecret && config.googleRefreshToken) {
      try {
        await new GoogleCalendarService(config.googleClientId, config.googleClientSecret, config.googleRefreshToken, config.googleRedirectUri)
          .deleteProjectCalendar(project.calendarId);
        await new CalendarStateStore().removeProject(project.id);
      } catch (error) {
        console.warn(`Google Calendar 삭제 실패 (${project.name}):`, error);
        warnings.push("Google Calendar");
      }
    }
    if (category) {
      const children = channels.filter((channel) => channel?.parentId === category.id);
      for (const channel of children.values()) {
        if (channel) {
          await channel.delete(`${project.name} ?熬곣뫁夷??釉띾콦 ??????);
        }
      }
      await category.delete(`${project.name} ?熬곣뫁夷??釉띾콦 ??????);
    }

    const deleted = await deleteProject(project.id);
    if (!deleted) throw new Error("?熬곣뫁夷??釉띾콦 ?????筌먲퐢沅???????? 嶺뚮쪇沅?쭛???鍮??");

    const warningText = warnings.length > 0
      ? `\n??ル쵑???筌? ??⑤베吏??筌먲퐘遊????덉넮: ${warnings.join(", ")} (??類ㅼ뮅 ?β돦裕???筌먦끉逾?`
      : "";
    await interaction.editReply(`??**${project.name}** ?熬곣뫁夷??釉띾콦 ?꾩렮維???????筌먲퐢沅????????곕????덈펲.${warningText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "???????⑸츎 ???댁쾼?띠럾? ?꾩룇裕뉑틦???곕????덈펲.";
    await interaction.editReply(`???熬곣뫁夷??釉띾콦 ??????????덉넮???곕????덈펲.\n\`${message}\``);
  }
}

export async function handleProjectCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: "??類ㅼ뮅 ???고뱺??類ㅼ떳 ??????????곕????덈펲." });
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
      throw new Error("Frontend?? Backend ????????띠룇?? GitHub Organization ?熬곣뫁??????곗꽑????紐껊퉵??");
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
      throw new Error("Frontend?? Backend ????????띠룇?? GitHub Organization ?熬곣뫁??????곗꽑????紐껊퉵??");
    }

    if (frontendOwner.type !== "Organization" || backendOwner.type !== "Organization") {
      throw new Error(`GitHub owner "${frontendOwner.login}"?띠럾? Organization???熬곣뫀六???덈펲.`);
    }

    const organization = frontendOwner.login;
    const category = await interaction.guild.channels.create({ name: `?獄?${name}`, type: ChannelType.GuildCategory });
    const createdChannelIds: string[] = [];
    const githubHooks: GitHubHook[] = [];
    let figmaWebhookId: string | null = null;
    let storedProjectId: string | null = null;`r`n    let calendarId: string | null = null;`r`n    let calendarUrl: string | undefined;

    try {
      const overview = await createTextChannel(interaction.guild, category.id, "?獄???щ뒆?β돦裕???);
      const spec = await createTextChannel(interaction.guild, category.id, "?獄??怨뺚뵛?縕ワ㎖?筌뤾쑨??);
      const figma = await createTextChannel(interaction.guild, category.id, "????異둮ma");
      const frontendLog = await createTextChannel(interaction.guild, category.id, "?獒??異뱋ntend-log");
      const backendLog = await createTextChannel(interaction.guild, category.id, "????已냖kend-log");
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
        new ButtonBuilder().setCustomId(`project_join:${storedProject.id}`).setLabel("GitHub Organization 嶺뚣볦굣??).setEmoji("??").setStyle(ButtonStyle.Primary),
      );

      const overviewMessage = await overview.send({
        content: "@everyone",
        allowedMentions: { parse: ["everyone"] },
        embeds: [new EmbedBuilder().setTitle(name).setDescription("?熬곣뫁夷??釉띾콦 ??쒖굣??? ?띠룇裕녻???????섎ご???蹂κ텛???????㉱?洹먮뿫????덈펲.\n\n????? ?熬곣뫁???뺢퀗????怨쀬Ŧ GitHub Organization ?貫??????븐슙????????곕????덈펲.").addFields(
          { name: "?リ옇????춻??얠돪??, value: notionPage.url },
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
          .setTitle("?獄??リ옇????춻??얠돪??)
          .setDescription("Notion??????熬곣뫁夷??釉띾콦 ?リ옇????춻??얠돪??? ?筌먦끉逾??紐껊퉵??\n\n??瑜곷턄嶺뚯솘??띠럾? ??瑜곸젧??濡?듆 ??嶺??х몭???곌떠??????逾???リ옇?▽빳??紐껊퉵??")
          .setURL(notionPage.url)],
        components: [linkButton("Notion ???⒱뵛", notionPage.url)],
      });
      await specMessage.pin();
      const figmaMessage = await figma.send({
        embeds: [new EmbedBuilder()
          .setTitle("???Figma")
          .setDescription("?熬곣뫁夷??釉띾콦 UI/UX ??븐슦??筌뤾쑴諭??筌먦끉逾??紐껊퉵??\n\nFigma????????藥????덈츎 ?뺢퀗??????諛댁뎽???삵깴?????癰?/???????얜????濡?듆 ??嶺??х몭?????逾???リ옇?▽빳??紐껊퉵??")
          .setURL(figmaFile.url)],
        components: [linkButton("Figma ???⒱뵛", figmaFile.url)],
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

      await frontendLog.send({ embeds: [new EmbedBuilder().setTitle("??Frontend GitHub ??⑤슡???熬곣뫁??).setDescription(frontendRepo.url).setURL(frontendRepo.url)] });
      await backendLog.send({ embeds: [new EmbedBuilder().setTitle("??Backend GitHub ??⑤슡???熬곣뫁??).setDescription(backendRepo.url).setURL(backendRepo.url)] });
      await interaction.editReply(`??**${name}** ?熬곣뫁夷??釉띾콦 ??諛댁뎽 + Notion ??瑜곸젧 ???逾?+ Figma ?뺢퀗????癰? ???逾?+ GitHub ?β돦裕??+ Organization 嶺뚣볦굣???뺢퀗???ろ떐?? ?熬곣뫁????곕????덈펲.`);
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
        try { await interaction.guild.channels.delete(id, "?熬곣뫁夷??釉띾콦 ??諛댁뎽 ???덉넮 ?β뼯?뉐첎?); } catch {}
      }
      try { await category.delete("?熬곣뫁夷??釉띾콦 ??諛댁뎽 ???덉넮 ?β뼯?뉐첎?); } catch {}
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "???????⑸츎 ???댁쾼?띠럾? ?꾩룇裕뉑틦???곕????덈펲.";
    await interaction.editReply(`???熬곣뫁夷??釉띾콦 ??諛댁뎽?????덉넮???곕????덈펲.\n\`${message}\``);
  }
}
