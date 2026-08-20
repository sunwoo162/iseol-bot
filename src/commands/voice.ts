import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { renderVoiceGrass } from "../services/voice-grass.js";
import {
  assertUserInBotVoiceChannel,
  joinUserVoiceChannel,
  leaveGuildVoiceChannel,
} from "../services/voice-connection.js";
import {
  getActiveStudySession,
  getDailyStudySeconds,
  startStudySession,
  stopStudySessionsForGuild,
} from "../services/voice-time.js";

export const voiceCommand = new SlashCommandBuilder()
  .setName("voice")
  .setDescription("이설이의 음성 채널 및 공부 시간 기능을 사용합니다.")
  .addSubcommand((subcommand) => subcommand
    .setName("join")
    .setDescription("내가 있는 음성 채널로 이설이를 부릅니다."))
  .addSubcommand((subcommand) => subcommand
    .setName("leave")
    .setDescription("이설이를 음성 채널에서 내보내고 진행 중인 공부 측정을 저장합니다."))
  .addSubcommand((subcommand) => subcommand
    .setName("study")
    .setDescription("이설이를 음성 채널에 부르고 나갈 때까지 공부 시간을 측정합니다."))
  .addSubcommand((subcommand) => subcommand
    .setName("grass")
    .setDescription("내 음성 공부 시간을 GitHub 잔디 형태로 확인합니다."));

export async function handleVoiceCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "grass") {
    await interaction.deferReply();
    try {
      const dailySeconds = await getDailyStudySeconds(interaction.guild.id, interaction.user.id);
      const displayName = interaction.user.globalName ?? interaction.user.username;
      const image = await renderVoiceGrass(dailySeconds, displayName);
      const totalSeconds = Object.values(dailySeconds).reduce((sum, value) => sum + value, 0);
      const totalHours = (totalSeconds / 3600).toFixed(1);

      await interaction.editReply({
        content: `🌱 <@${interaction.user.id}>님의 누적 음성 공부 시간은 **${totalHours}시간**입니다.`,
        files: [new AttachmentBuilder(image, { name: "voice-study-grass.png" })],
        allowedMentions: { users: [] },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
      await interaction.editReply(`❌ 공부 잔디 생성 실패\n\`${message}\``);
    }
    return;
  }

  await interaction.deferReply();

  try {
    if (subcommand === "join") {
      const connection = await joinUserVoiceChannel(interaction.guild, interaction.user.id);
      await interaction.editReply(`🔊 이설이가 <#${connection.joinConfig.channelId}> 음성 채널에 들어왔습니다.`);
      return;
    }

    if (subcommand === "study") {
      const existing = await getActiveStudySession(interaction.guild.id, interaction.user.id);
      if (existing) {
        await interaction.editReply(`⏱️ 이미 <#${existing.channelId}>에서 공부 시간이 측정 중입니다.`);
        return;
      }

      const connection = await joinUserVoiceChannel(interaction.guild, interaction.user.id);
      const channelId = connection.joinConfig.channelId;
      if (!channelId) throw new Error("연결된 음성 채널을 확인할 수 없습니다.");

      await startStudySession(interaction.guild.id, interaction.user.id, channelId);
      await interaction.editReply(
        `⏱️ <@${interaction.user.id}>님의 공부 시간 측정을 시작했습니다.\n` +
        `<#${channelId}>에서 이설이가 나갈 때까지 시간이 누적됩니다.`,
      );
      return;
    }

    if (subcommand === "leave") {
      await assertUserInBotVoiceChannel(interaction.guild, interaction.user.id);
      const stopped = await stopStudySessionsForGuild(interaction.guild.id);
      const left = leaveGuildVoiceChannel(interaction.guild.id);
      if (!left) throw new Error("이설이가 들어가 있는 음성 채널이 없습니다.");

      await interaction.editReply(
        stopped.length > 0
          ? `👋 음성 채널에서 나왔습니다. 공부 시간 측정 **${stopped.length}명**의 기록을 저장했습니다.`
          : "👋 음성 채널에서 나왔습니다.",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    await interaction.editReply(`❌ 음성 명령 처리 실패\n\`${message}\``);
  }
}
