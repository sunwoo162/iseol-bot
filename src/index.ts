import "./services/fetch-fallback.js";
import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { handleContestCommandV2 } from "./commands/contest-v2.js";
import { handleContestVoteButton } from "./commands/contest.js";
import { handleGitHubCommand } from "./commands/github.js";
import { handleJobCommand } from "./commands/job.js";
import { config } from "./config.js";
import { handleMusicAutocomplete, handleMusicCommand } from "./commands/music.js";
import { handleProjectAutocomplete, handleProjectCommand } from "./commands/project.js";
import { handleScrumAutocomplete, handleScrumCommand } from "./commands/scrum.js";
import { handleVoiceCommand } from "./commands/voice.js";
import { commandHelpEmbed } from "./services/command-help.js";`r`nimport { handleCalendarButton, handleCalendarModal } from "./services/calendar/calendar-discord.js";
import { startContestAudienceFeedPolling } from "./services/contest-audience-feed.js";
import { startContestFeedPolling } from "./services/contest-feed.js";
import { ensureContestPrepAnnouncementChannels } from "./services/contest-prep-announcement.js";
import { startDailyScrumReminderScheduler } from "./services/daily-scrum.js";
import { resetGuildState } from "./services/guild-reset.js";
import { startGitHubCommitFeedPolling } from "./services/github-commit-feed.js";
import { GitHubWebhookService } from "./services/github.js";
import { startJobFeedPolling } from "./services/job-feed.js";
import { ensureProjectDiscussionChannels } from "./services/project-discussion.js";
import { findProject } from "./services/projects.js";
import { handleVoiceAutoLeave } from "./services/voice-auto-leave.js";
import {
  getActiveStudySession,
  recoverInterruptedStudySessions,
  startVoiceStudyHeartbeat,
  stopStudySession,
} from "./services/voice-time.js";
import { startWebhookServer } from "./services/webhook-server.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});
const github = new GitHubWebhookService(config.githubToken);

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`${readyClient.user.tag} 濡쒓렇???꾨즺 쨌 ?곌껐 ?쒕쾭 ${readyClient.guilds.cache.size}媛?);
  startWebhookServer(client);
  startContestFeedPolling(client);
  startContestAudienceFeedPolling(client);
  startJobFeedPolling(client);
  startGitHubCommitFeedPolling(client);
  startVoiceStudyHeartbeat();

  const interruptedSessions = await recoverInterruptedStudySessions();
  if (interruptedSessions > 0) {
    console.log(`?댁쟾 ?ㅽ뻾?먯꽌 醫낅즺?섏? ?딆? ?뚯꽦 怨듬? ?몄뀡 ?뺣━: ${interruptedSessions}媛?);
  }

  await ensureProjectDiscussionChannels(client);
  await ensureContestPrepAnnouncementChannels(client);
  startDailyScrumReminderScheduler(client);
});

client.on(Events.GuildCreate, (guild) => {
  console.log(`Discord ?쒕쾭 ?곌껐: ${guild.name} (${guild.id}) 쨌 珥?${client.guilds.cache.size}媛?);
});

client.on(Events.GuildDelete, (guild) => {
  console.log(`Discord ?쒕쾭 ?곌껐 ?댁젣: ${guild.name} (${guild.id}) 쨌 珥?${client.guilds.cache.size}媛?);
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (!oldState.member?.user.bot) {
    try {
      const session = await getActiveStudySession(oldState.guild.id, oldState.id);
      if (
        session
        && oldState.channelId === session.channelId
        && newState.channelId !== session.channelId
      ) {
        const stopped = await stopStudySession(oldState.guild.id, oldState.id);
        if (stopped) {
          console.log(`?뚯꽦 怨듬? ?먮룞 醫낅즺 (${oldState.guild.id}/${oldState.id}): ${Math.round(stopped.seconds)}珥?);
        }
      }
    } catch (error) {
      console.error(`?뚯꽦 怨듬? ?먮룞 醫낅즺 ?ㅽ뙣 (${oldState.guild.id}/${oldState.id})`, error);
    }
  }

  try {
    await handleVoiceAutoLeave(newState.guild);
  } catch (error) {
    console.error(`?뚯꽦 梨꾨꼸 ?먮룞 ?댁옣 ?곹깭 ?뺤씤 ?ㅽ뙣 (${newState.guild.id})`, error);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.inGuild()) return;

  const content = message.content.trim();
  if (content === "!愿由ъ옄沅뚰븳珥덇린??) {
    if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
      await message.reply({
        content: "???쒕쾭 愿由ъ옄留??ъ슜?????덉뒿?덈떎.",
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    await message.reply({
      content: "?좑툘 ?댁꽕???앹꽦???쒕쾭 怨듦컙怨?????곗씠?곕? 珥덇린?뷀빀?덈떎. ?꾨즺 寃곌낵????梨꾨꼸 ?먮뒗 DM?쇰줈 ?뚮젮?쒕┰?덈떎.",
      allowedMentions: { repliedUser: false },
    });

    try {
      const summary = await resetGuildState(message.guild);
      const warningText = summary.warnings.length > 0
        ? `\n?좑툘 ?쇰? ?뺣━ ?ㅽ뙣: **${summary.warnings.length}嫄?* (?쒕쾭 濡쒓렇 ?뺤씤)`
        : "";
      const report =
        `??**${message.guild.name}** ?댁꽕 珥덇린???꾨즺\n` +
        `??젣??Discord 梨꾨꼸/移댄뀒怨좊━: **${summary.deletedChannels}媛?*\n` +
        `珥덇린?뷀븳 ????곗씠?? **${summary.clearedRecords}嫄?*\n` +
        `??젣??GitHub webhook: **${summary.removedExternalHooks}媛?*${warningText}`;

      console.log(`愿由ъ옄 ?쒕쾭 珥덇린???꾨즺 (${message.guild.id})`, summary);
      await message.channel.send(report).catch(async () => {
        await message.author.send(report).catch(() => undefined);
      });
    } catch (error) {
      console.error(`愿由ъ옄 ?쒕쾭 珥덇린???ㅽ뙣 (${message.guild.id})`, error);
      const detail = error instanceof Error ? error.message : "?????녿뒗 ?ㅻ쪟";
      await message.author.send(`???쒕쾭 珥덇린?붿뿉 ?ㅽ뙣?덉뒿?덈떎.\n\`${detail}\``).catch(() => undefined);
    }
    return;
  }

  if (content !== "!紐낅졊??) return;

  await message.reply({
    embeds: [commandHelpEmbed()],
    allowedMentions: { repliedUser: false },
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "project") await handleProjectAutocomplete(interaction);
      if (interaction.commandName === "music") await handleMusicAutocomplete(interaction);
      if (interaction.commandName === "scrum") await handleScrumAutocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "project") {
        await handleProjectCommand(interaction);
        await ensureProjectDiscussionChannels(client);
      }
      if (interaction.commandName === "contest") await handleContestCommandV2(interaction);
      if (interaction.commandName === "job") await handleJobCommand(interaction);
      if (interaction.commandName === "github") await handleGitHubCommand(interaction);
      if (interaction.commandName === "scrum") await handleScrumCommand(interaction);
      if (interaction.commandName === "voice") await handleVoiceCommand(interaction);
      if (interaction.commandName === "music") await handleMusicCommand(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("calendar:")) {
      if (await handleCalendarButton(interaction)) return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("contest_vote:")) {
      await handleContestVoteButton(interaction);
      await ensureContestPrepAnnouncementChannels(client);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("project_join:")) {
      const projectId = interaction.customId.split(":")[1];
      const project = projectId ? await findProject(projectId) : null;
      if (!project || project.guildId !== interaction.guildId) {
        await interaction.reply({ content: "?꾨줈?앺듃 ?뺣낫瑜?李얠쓣 ???놁뒿?덈떎.", ephemeral: true });
        return;
      }

      const username = new TextInputBuilder().setCustomId("github_username").setLabel("GitHub ?ъ슜?먮챸").setPlaceholder("?? sunwoo162").setMinLength(1).setMaxLength(39).setRequired(true).setStyle(TextInputStyle.Short);
      const modal = new ModalBuilder().setCustomId(`project_join_modal:${project.id}`).setTitle(`${project.name} 李몄뿬`);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(username));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("calendar_")) {
      if (await handleCalendarModal(interaction)) return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("project_join_modal:")) {
      const projectId = interaction.customId.split(":")[1];
      const project = projectId ? await findProject(projectId) : null;
      if (!project || project.guildId !== interaction.guildId) {
        await interaction.reply({ content: "?꾨줈?앺듃 ?뺣낫瑜?李얠쓣 ???놁뒿?덈떎.", ephemeral: true });
        return;
      }

      const username = interaction.fields.getTextInputValue("github_username").trim().replace(/^@/, "");
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) {
        await interaction.reply({ content: "???щ컮瑜?GitHub ?ъ슜?먮챸???낅젰?댁＜?몄슂.", ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      try {
        await github.inviteOrganizationMember(project.organization, username);
        await interaction.editReply(`??**@${username}** 怨꾩젙?쇰줈 **${project.organization}** Organization 珥덈?瑜?蹂대깉?듬땲??\nGitHub ?뚮┝ ?먮뒗 ?대찓?쇱뿉??珥덈?瑜??섎씫?섎㈃ ?⑸쪟媛 ?꾨즺?⑸땲??`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "?????녿뒗 ?ㅻ쪟媛 諛쒖깮?덉뒿?덈떎.";
        await interaction.editReply(`??GitHub Organization 珥덈????ㅽ뙣?덉뒿?덈떎.\n\`${message}\`\n\n?대? 硫ㅻ쾭/珥덈? ?湲?以묒씤吏, ?먮뒗 ?좏겙??Organization Members ?곌린 沅뚰븳???덈뒗吏 ?뺤씤?댁＜?몄슂.`);
      }
    }
  } catch (error) {
    console.error(error);
    if (interaction.isRepliable() && !interaction.deferred && !interaction.replied) {
      await interaction.reply({ content: "紐낅졊 泥섎━ 以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎.", ephemeral: true }).catch(() => undefined);
    }
  }
});

await client.login(config.discordToken);
