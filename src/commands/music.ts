import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import {
  addTrackToPlaylist,
  createPlaylist,
  getPlaylist,
  listPlaylists,
  playMusicPlaylist,
  skipMusic,
  stopMusic,
  type MusicTrack,
} from "../services/music.js";
import { assertUserInBotVoiceChannel } from "../services/voice-connection.js";

export const musicCommand = new SlashCommandBuilder()
  .setName("music")
  .setDescription("이설이의 음악 플레이리스트를 관리하고 재생합니다.")
  .addSubcommand((subcommand) => subcommand
    .setName("playlist-create")
    .setDescription("새 플레이리스트를 만듭니다.")
    .addStringOption((option) => option
      .setName("name")
      .setDescription("플레이리스트 이름")
      .setRequired(true)))
  .addSubcommand((subcommand) => subcommand
    .setName("playlist-add")
    .setDescription("플레이리스트에 노래를 추가합니다.")
    .addStringOption((option) => option
      .setName("playlist")
      .setDescription("플레이리스트 이름")
      .setRequired(true))
    .addStringOption((option) => option
      .setName("song")
      .setDescription("노래 제목 또는 YouTube 링크")
      .setRequired(true)))
  .addSubcommand((subcommand) => subcommand
    .setName("playlist-show")
    .setDescription("플레이리스트 목록 또는 수록곡을 확인합니다.")
    .addStringOption((option) => option
      .setName("playlist")
      .setDescription("확인할 플레이리스트 이름 (비우면 전체 목록)")))
  .addSubcommand((subcommand) => subcommand
    .setName("play")
    .setDescription("플레이리스트를 현재 음성 채널에서 재생합니다.")
    .addStringOption((option) => option
      .setName("playlist")
      .setDescription("재생할 플레이리스트 이름")
      .setRequired(true)))
  .addSubcommand((subcommand) => subcommand
    .setName("skip")
    .setDescription("현재 재생 중인 노래를 넘깁니다."))
  .addSubcommand((subcommand) => subcommand
    .setName("stop")
    .setDescription("음악 재생과 대기열을 정지합니다."));

function playlistEmbed(name: string, tracks: MusicTrack[]): EmbedBuilder {
  const lines = tracks.slice(0, 30).map((track, index) => `${index + 1}. [${track.title}](${track.url})`);
  const hidden = Math.max(0, tracks.length - lines.length);

  return new EmbedBuilder()
    .setTitle(`🎵 ${name}`)
    .setDescription(lines.length > 0
      ? `${lines.join("\n")}${hidden > 0 ? `\n\n외 ${hidden}곡` : ""}`
      : "아직 추가된 노래가 없습니다.")
    .setFooter({ text: `총 ${tracks.length}곡` });
}

export async function handleMusicCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  await interaction.deferReply();

  try {
    if (subcommand === "playlist-create") {
      const name = interaction.options.getString("name", true);
      const playlist = await createPlaylist(interaction.guild.id, name);
      await interaction.editReply(`✅ **${playlist.name}** 플레이리스트를 만들었습니다.`);
      return;
    }

    if (subcommand === "playlist-add") {
      const playlistName = interaction.options.getString("playlist", true);
      const song = interaction.options.getString("song", true);
      const { playlist, track } = await addTrackToPlaylist(
        interaction.guild.id,
        playlistName,
        song,
        interaction.user.id,
      );

      await interaction.editReply(
        `➕ **${playlist.name}**에 [${track.title}](${track.url})을 추가했습니다.\n현재 **${playlist.tracks.length}곡**입니다.`,
      );
      return;
    }

    if (subcommand === "playlist-show") {
      const name = interaction.options.getString("playlist")?.trim();
      if (name) {
        const playlist = await getPlaylist(interaction.guild.id, name);
        if (!playlist) throw new Error(`플레이리스트 \"${name}\"을 찾을 수 없습니다.`);
        await interaction.editReply({ embeds: [playlistEmbed(playlist.name, playlist.tracks)] });
        return;
      }

      const playlists = await listPlaylists(interaction.guild.id);
      if (playlists.length === 0) {
        await interaction.editReply("아직 만든 플레이리스트가 없습니다.");
        return;
      }

      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle("🎶 플레이리스트")
          .setDescription(playlists.map((playlist, index) => `${index + 1}. **${playlist.name}** · ${playlist.tracks.length}곡`).join("\n"))],
      });
      return;
    }

    if (subcommand === "play") {
      const playlistName = interaction.options.getString("playlist", true);
      const result = await playMusicPlaylist(interaction.guild, interaction.user.id, playlistName);
      await interaction.editReply(
        `▶️ **${result.playlist.name}** 재생을 시작했습니다.\n` +
        `${result.current ? `현재 곡: **${result.current.title}**\n` : ""}` +
        `대기열: **${result.queued}곡**`,
      );
      return;
    }

    if (subcommand === "skip") {
      await assertUserInBotVoiceChannel(interaction.guild, interaction.user.id);
      const skipped = skipMusic(interaction.guild.id);
      if (!skipped) throw new Error("현재 재생 중인 노래가 없습니다.");
      await interaction.editReply(`⏭️ **${skipped.title}**을 건너뛰었습니다.`);
      return;
    }

    if (subcommand === "stop") {
      await assertUserInBotVoiceChannel(interaction.guild, interaction.user.id);
      const stopped = stopMusic(interaction.guild.id);
      if (!stopped) throw new Error("현재 재생 중인 음악이 없습니다.");
      await interaction.editReply("⏹️ 음악 재생과 대기열을 정지했습니다.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    await interaction.editReply(`❌ 음악 명령 처리 실패\n\`${message}\``);
  }
}
