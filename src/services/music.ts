import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  createAudioPlayer,
  createAudioResource,
  type AudioPlayer,
} from "@discordjs/voice";
import type { Guild } from "discord.js";
import * as play from "play-dl";
import { joinUserVoiceChannel } from "./voice-connection.js";

const DATA_FILE = resolve(process.cwd(), "data", "music-playlists.json");

export type MusicTrack = {
  title: string;
  url: string;
  addedBy: string;
};

export type MusicPlaylist = {
  name: string;
  tracks: MusicTrack[];
};

type MusicData = {
  guilds: Record<string, MusicPlaylist[]>;
};

type GuildMusicState = {
  player: AudioPlayer;
  queue: MusicTrack[];
  current?: MusicTrack;
  initialized: boolean;
};

const runtime = new Map<string, GuildMusicState>();
let writeQueue: Promise<void> = Promise.resolve();

async function readData(): Promise<MusicData> {
  try {
    const parsed = JSON.parse(await readFile(DATA_FILE, "utf8")) as Partial<MusicData>;
    return { guilds: parsed.guilds ?? {} };
  } catch {
    return { guilds: {} };
  }
}

async function writeData(data: MusicData): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function updateData<T>(updater: (data: MusicData) => T | Promise<T>): Promise<T> {
  let result!: T;
  let error: unknown;

  writeQueue = writeQueue.then(async () => {
    try {
      const data = await readData();
      result = await updater(data);
      await writeData(data);
    } catch (caught) {
      error = caught;
    }
  });

  await writeQueue;
  if (error) throw error;
  return result;
}

function normalizePlaylistName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function findPlaylist(playlists: MusicPlaylist[], name: string): MusicPlaylist | undefined {
  const normalized = normalizePlaylistName(name);
  return playlists.find((playlist) => normalizePlaylistName(playlist.name) === normalized);
}

export async function createPlaylist(guildId: string, name: string): Promise<MusicPlaylist> {
  const cleanName = name.trim().slice(0, 80);
  if (!cleanName) throw new Error("플레이리스트 이름을 입력해주세요.");

  return updateData((data) => {
    const playlists = data.guilds[guildId] ?? [];
    if (findPlaylist(playlists, cleanName)) throw new Error("같은 이름의 플레이리스트가 이미 있습니다.");

    const playlist: MusicPlaylist = { name: cleanName, tracks: [] };
    playlists.push(playlist);
    data.guilds[guildId] = playlists;
    return playlist;
  });
}

async function resolveTrack(query: string, userId: string): Promise<MusicTrack> {
  const input = query.trim();
  if (!input) throw new Error("노래 제목이나 YouTube 링크를 입력해주세요.");

  const validation = await play.validate(input);
  if (validation === "yt_video") {
    const info = await play.video_basic_info(input);
    return {
      title: info.video_details.title,
      url: info.video_details.url,
      addedBy: userId,
    };
  }

  const results = await play.search(input, {
    limit: 1,
    source: { youtube: "video" },
  });
  const video = results[0];
  if (!video) throw new Error("YouTube에서 해당 노래를 찾지 못했습니다.");

  return {
    title: video.title ?? input,
    url: video.url,
    addedBy: userId,
  };
}

export async function addTrackToPlaylist(
  guildId: string,
  playlistName: string,
  query: string,
  userId: string,
): Promise<{ playlist: MusicPlaylist; track: MusicTrack }> {
  const track = await resolveTrack(query, userId);

  return updateData((data) => {
    const playlists = data.guilds[guildId] ?? [];
    const playlist = findPlaylist(playlists, playlistName);
    if (!playlist) throw new Error(`플레이리스트 \"${playlistName}\"을 찾을 수 없습니다.`);

    playlist.tracks.push(track);
    data.guilds[guildId] = playlists;
    return { playlist: { ...playlist, tracks: [...playlist.tracks] }, track };
  });
}

export async function listPlaylists(guildId: string): Promise<MusicPlaylist[]> {
  await writeQueue;
  const data = await readData();
  return (data.guilds[guildId] ?? []).map((playlist) => ({
    ...playlist,
    tracks: [...playlist.tracks],
  }));
}

export async function getPlaylist(guildId: string, name: string): Promise<MusicPlaylist | null> {
  const playlists = await listPlaylists(guildId);
  return findPlaylist(playlists, name) ?? null;
}

function getRuntimeState(guildId: string): GuildMusicState {
  const existing = runtime.get(guildId);
  if (existing) return existing;

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  const state: GuildMusicState = {
    player,
    queue: [],
    initialized: false,
  };

  player.on(AudioPlayerStatus.Idle, () => {
    state.current = undefined;
    void playNext(guildId);
  });
  player.on("error", (error) => {
    console.error(`음악 재생 실패 (${guildId})`, error);
    state.current = undefined;
    void playNext(guildId);
  });

  runtime.set(guildId, state);
  return state;
}

async function playNext(guildId: string): Promise<void> {
  const state = runtime.get(guildId);
  if (!state || state.current) return;

  const track = state.queue.shift();
  if (!track) return;

  state.current = track;
  try {
    const stream = await play.stream(track.url);
    const resource = createAudioResource(stream.stream, { inputType: stream.type });
    state.player.play(resource);
  } catch (error) {
    console.error(`노래 스트림 생성 실패 (${track.title})`, error);
    state.current = undefined;
    await playNext(guildId);
  }
}

export async function playMusicPlaylist(
  guild: Guild,
  userId: string,
  playlistName: string,
): Promise<{ playlist: MusicPlaylist; current?: MusicTrack; queued: number }> {
  const playlist = await getPlaylist(guild.id, playlistName);
  if (!playlist) throw new Error(`플레이리스트 \"${playlistName}\"을 찾을 수 없습니다.`);
  if (playlist.tracks.length === 0) throw new Error("플레이리스트에 노래가 없습니다.");

  const connection = await joinUserVoiceChannel(guild, userId);
  const state = getRuntimeState(guild.id);
  if (!state.initialized) {
    connection.subscribe(state.player);
    state.initialized = true;
  } else {
    connection.subscribe(state.player);
  }

  state.queue.push(...playlist.tracks);
  await playNext(guild.id);

  return {
    playlist,
    current: state.current,
    queued: state.queue.length,
  };
}

export function skipMusic(guildId: string): MusicTrack | null {
  const state = runtime.get(guildId);
  if (!state?.current) return null;
  const skipped = state.current;
  state.current = undefined;
  state.player.stop(true);
  return skipped;
}

export function stopMusic(guildId: string): boolean {
  const state = runtime.get(guildId);
  if (!state) return false;
  state.queue = [];
  state.current = undefined;
  state.player.stop(true);
  return true;
}

export function clearMusicRuntime(guildId: string): void {
  const state = runtime.get(guildId);
  if (!state) return;
  state.queue = [];
  state.current = undefined;
  state.player.stop(true);
  runtime.delete(guildId);
}
