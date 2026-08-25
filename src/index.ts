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
import { commandHelpEmbed } from "./services/command-help.js";
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
  console.log(`${readyClient.user.tag} 로그인 완료 · 연결 서버 ${readyClient.guilds.cache.size}개`);
  startWebhookServer(client);
  startContestFeedPolling(client);
  startContestAudienceFeedPolling(client);
  startJobFeedPolling(client);
  startGitHubCommitFeedPolling(client);
  startVoiceStudyHeartbeat();

  const interruptedSessions = await recoverInterruptedStudySessions();
  if (interruptedSessions > 0) {
    console.log(`이전 실행에서 종료되지 않은 음성 공부 세션 정리: ${interruptedSessions}개`);
  }

  await ensureProjectDiscussionChannels(client);
  await ensureContestPrepAnnouncementChannels(client);
  startDailyScrumReminderScheduler(client);
});

client.on(Events.GuildCreate, (guild) => {
  console.log(`Discord 서버 연결: ${guild.name} (${guild.id}) · 총 ${client.guilds.cache.size}개`);
});

client.on(Events.GuildDelete, (guild) => {
  console.log(`Discord 서버 연결 해제: ${guild.name} (${guild.id}) · 총 ${client.guilds.cache.size}개`);
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
          console.log(`음성 공부 자동 종료 (${oldState.guild.id}/${oldState.id}): ${Math.round(stopped.seconds)}초`);
        }
      }
    } catch (error) {
      console.error(`음성 공부 자동 종료 실패 (${oldState.guild.id}/${oldState.id})`, error);
    }
  }

  try {
    await handleVoiceAutoLeave(newState.guild);
  } catch (error) {
    console.error(`음성 채널 자동 퇴장 상태 확인 실패 (${newState.guild.id})`, error);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.inGuild()) return;

  const content = message.content.trim();
  if (content === "!관리자권한초기화") {
    if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
      await message.reply({
        content: "❌ 서버 관리자만 사용할 수 있습니다.",
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    await message.reply({
      content: "⚠️ 이설이 생성한 서버 공간과 저장 데이터를 초기화합니다. 완료 결과는 이 채널 또는 DM으로 알려드립니다.",
      allowedMentions: { repliedUser: false },
    });

    try {
      const summary = await resetGuildState(message.guild);
      const warningText = summary.warnings.length > 0
        ? `\n⚠️ 일부 정리 실패: **${summary.warnings.length}건** (서버 로그 확인)`
        : "";
      const report =
        `✅ **${message.guild.name}** 이설 초기화 완료\n` +
        `삭제한 Discord 채널/카테고리: **${summary.deletedChannels}개**\n` +
        `초기화한 저장 데이터: **${summary.clearedRecords}건**\n` +
        `삭제한 GitHub webhook: **${summary.removedExternalHooks}개**${warningText}`;

      console.log(`관리자 서버 초기화 완료 (${message.guild.id})`, summary);
      await message.channel.send(report).catch(async () => {
        await message.author.send(report).catch(() => undefined);
      });
    } catch (error) {
      console.error(`관리자 서버 초기화 실패 (${message.guild.id})`, error);
      const detail = error instanceof Error ? error.message : "알 수 없는 오류";
      await message.author.send(`❌ 서버 초기화에 실패했습니다.\n\`${detail}\``).catch(() => undefined);
    }
    return;
  }

  if (content !== "!명령어") return;

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

    if (interaction.isButton() && interaction.customId.startsWith("contest_vote:")) {
      await handleContestVoteButton(interaction);
      await ensureContestPrepAnnouncementChannels(client);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("project_join:")) {
      const projectId = interaction.customId.split(":")[1];
      const project = projectId ? await findProject(projectId) : null;
      if (!project || project.guildId !== interaction.guildId) {
        await interaction.reply({ content: "프로젝트 정보를 찾을 수 없습니다.", ephemeral: true });
        return;
      }

      const username = new TextInputBuilder().setCustomId("github_username").setLabel("GitHub 사용자명").setPlaceholder("예: sunwoo162").setMinLength(1).setMaxLength(39).setRequired(true).setStyle(TextInputStyle.Short);
      const modal = new ModalBuilder().setCustomId(`project_join_modal:${project.id}`).setTitle(`${project.name} 참여`);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(username));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("project_join_modal:")) {
      const projectId = interaction.customId.split(":")[1];
      const project = projectId ? await findProject(projectId) : null;
      if (!project || project.guildId !== interaction.guildId) {
        await interaction.reply({ content: "프로젝트 정보를 찾을 수 없습니다.", ephemeral: true });
        return;
      }

      const username = interaction.fields.getTextInputValue("github_username").trim().replace(/^@/, "");
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) {
        await interaction.reply({ content: "❌ 올바른 GitHub 사용자명을 입력해주세요.", ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      try {
        await github.inviteOrganizationMember(project.organization, username);
        await interaction.editReply(`✅ **@${username}** 계정으로 **${project.organization}** Organization 초대를 보냈습니다.\nGitHub 알림 또는 이메일에서 초대를 수락하면 합류가 완료됩니다.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
        await interaction.editReply(`❌ GitHub Organization 초대에 실패했습니다.\n\`${message}\`\n\n이미 멤버/초대 대기 중인지, 또는 토큰에 Organization Members 쓰기 권한이 있는지 확인해주세요.`);
      }
    }
  } catch (error) {
    console.error(error);
    if (interaction.isRepliable() && !interaction.deferred && !interaction.replied) {
      await interaction.reply({ content: "명령 처리 중 오류가 발생했습니다.", ephemeral: true }).catch(() => undefined);
    }
  }
});

await client.login(config.discordToken);
