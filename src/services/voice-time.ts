import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DATA_FILE = resolve(process.cwd(), "data", "voice-study-time.json");
const HEARTBEAT_MS = 60_000;
const DAY_CHUNK_MS = 60_000;

type ActiveStudySession = {
  guildId: string;
  userId: string;
  channelId: string;
  startedAt: string;
  lastAccountedAt: string;
};

type VoiceStudyData = {
  dailySeconds: Record<string, Record<string, number>>;
  activeSessions: ActiveStudySession[];
};

export type StoppedStudySession = {
  userId: string;
  seconds: number;
};

let updateQueue: Promise<void> = Promise.resolve();
let heartbeatStarted = false;

function emptyData(): VoiceStudyData {
  return { dailySeconds: {}, activeSessions: [] };
}

async function readData(): Promise<VoiceStudyData> {
  try {
    const parsed = JSON.parse(await readFile(DATA_FILE, "utf8")) as Partial<VoiceStudyData>;
    return {
      dailySeconds: parsed.dailySeconds ?? {},
      activeSessions: parsed.activeSessions ?? [],
    };
  } catch {
    return emptyData();
  }
}

async function writeData(data: VoiceStudyData): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function updateData<T>(updater: (data: VoiceStudyData) => T | Promise<T>): Promise<T> {
  let result!: T;
  let error: unknown;

  updateQueue = updateQueue.then(async () => {
    try {
      const data = await readData();
      result = await updater(data);
      await writeData(data);
    } catch (caught) {
      error = caught;
    }
  });

  await updateQueue;
  if (error) throw error;
  return result;
}

function userKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

export function seoulDateKey(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addSeconds(data: VoiceStudyData, guildId: string, userId: string, dateKey: string, seconds: number): void {
  if (seconds <= 0) return;
  const key = userKey(guildId, userId);
  const days = data.dailySeconds[key] ?? {};
  days[dateKey] = (days[dateKey] ?? 0) + seconds;
  data.dailySeconds[key] = days;
}

function accountRange(
  data: VoiceStudyData,
  session: ActiveStudySession,
  from: Date,
  to: Date,
): number {
  let cursor = from.getTime();
  const end = to.getTime();
  let totalSeconds = 0;

  while (cursor < end) {
    const next = Math.min(cursor + DAY_CHUNK_MS, end);
    const seconds = Math.max(0, (next - cursor) / 1000);
    addSeconds(data, session.guildId, session.userId, seoulDateKey(new Date(cursor)), seconds);
    totalSeconds += seconds;
    cursor = next;
  }

  return totalSeconds;
}

export async function startStudySession(guildId: string, userId: string, channelId: string): Promise<void> {
  await updateData((data) => {
    const existing = data.activeSessions.find((session) => session.guildId === guildId && session.userId === userId);
    if (existing) throw new Error("이미 음성 공부 시간이 측정 중입니다.");

    const now = new Date().toISOString();
    data.activeSessions.push({
      guildId,
      userId,
      channelId,
      startedAt: now,
      lastAccountedAt: now,
    });
  });
}

export async function stopStudySessionsForGuild(guildId: string): Promise<StoppedStudySession[]> {
  return updateData((data) => {
    const now = new Date();
    const stopped: StoppedStudySession[] = [];
    const remaining: ActiveStudySession[] = [];

    for (const session of data.activeSessions) {
      if (session.guildId !== guildId) {
        remaining.push(session);
        continue;
      }

      const seconds = accountRange(data, session, new Date(session.lastAccountedAt), now);
      stopped.push({ userId: session.userId, seconds });
    }

    data.activeSessions = remaining;
    return stopped;
  });
}

export async function stopStudySession(guildId: string, userId: string): Promise<StoppedStudySession | null> {
  return updateData((data) => {
    const index = data.activeSessions.findIndex((session) => session.guildId === guildId && session.userId === userId);
    if (index < 0) return null;

    const session = data.activeSessions[index];
    if (!session) return null;
    const seconds = accountRange(data, session, new Date(session.lastAccountedAt), new Date());
    data.activeSessions.splice(index, 1);
    return { userId, seconds };
  });
}

export async function getDailyStudySeconds(guildId: string, userId: string): Promise<Record<string, number>> {
  await updateQueue;
  const data = await readData();
  return { ...(data.dailySeconds[userKey(guildId, userId)] ?? {}) };
}

export async function getActiveStudySession(guildId: string, userId: string): Promise<ActiveStudySession | null> {
  await updateQueue;
  const data = await readData();
  return data.activeSessions.find((session) => session.guildId === guildId && session.userId === userId) ?? null;
}

async function heartbeat(): Promise<void> {
  await updateData((data) => {
    const now = new Date();
    for (const session of data.activeSessions) {
      accountRange(data, session, new Date(session.lastAccountedAt), now);
      session.lastAccountedAt = now.toISOString();
    }
  });
}

export async function recoverInterruptedStudySessions(): Promise<number> {
  return updateData((data) => {
    const count = data.activeSessions.length;
    data.activeSessions = [];
    return count;
  });
}

export function startVoiceStudyHeartbeat(): void {
  if (heartbeatStarted) return;
  heartbeatStarted = true;
  setInterval(() => void heartbeat().catch((error) => console.error("음성 공부 시간 저장 실패", error)), HEARTBEAT_MS);
}
