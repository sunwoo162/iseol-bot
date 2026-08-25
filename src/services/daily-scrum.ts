import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ChannelType, Client, Guild, TextChannel } from "discord.js";
import { listProjects, type StoredProject } from "./projects.js";
import { seoulDateKey } from "./voice-time.js";

const DATA_FILE = resolve(process.cwd(), "data", "daily-scrum.json");
const DAY_MS = 86_400_000;
const SEOUL_OFFSET_HOURS = 9;
const REMINDER_HOUR = 8;

export const DAILY_SCRUM_CHANNEL_NAME = "🗓・데일리스크럼";

export type DailyScrumRecord = {
  guildId: string;
  projectId: string;
  userId: string;
  date: string;
  todo: string;
  did: string;
  channelId: string;
  messageId: string;
  updatedAt: string;
};

type DailyScrumData = {
  records: DailyScrumRecord[];
  reminderDates: Record<string, string>;
};

let updateQueue: Promise<void> = Promise.resolve();

function emptyData(): DailyScrumData {
  return { records: [], reminderDates: {} };
}

async function readData(): Promise<DailyScrumData> {
  try {
    const parsed = JSON.parse(await readFile(DATA_FILE, "utf8")) as Partial<DailyScrumData>;
    return {
      records: parsed.records ?? [],
      reminderDates: parsed.reminderDates ?? {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyData();
    throw error;
  }
}

async function writeData(data: DailyScrumData): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function updateData<T>(updater: (data: DailyScrumData) => T | Promise<T>): Promise<T> {
  let result!: T;
  let caught: unknown;

  updateQueue = updateQueue.then(async () => {
    try {
      const data = await readData();
      result = await updater(data);
      await writeData(data);
    } catch (error) {
      caught = error;
    }
  });

  await updateQueue;
  if (caught) throw caught;
  return result;
}

export function previousSeoulDateKey(date = new Date()): string {
  return seoulDateKey(new Date(date.getTime() - DAY_MS));
}

export async function getDailyScrumRecord(
  projectId: string,
  userId: string,
  date: string,
): Promise<DailyScrumRecord | null> {
  const data = await readData();
  return data.records.find((record) =>
    record.projectId === projectId
    && record.userId === userId
    && record.date === date,
  ) ?? null;
}

export async function saveDailyScrumRecord(record: DailyScrumRecord): Promise<void> {
  await updateData((data) => {
    const index = data.records.findIndex((item) =>
      item.projectId === record.projectId
      && item.userId === record.userId
      && item.date === record.date,
    );

    if (index >= 0) data.records[index] = record;
    else data.records.push(record);
  });
}

export async function findDailyScrumChannel(
  guild: Guild,
  project: StoredProject,
): Promise<TextChannel | null> {
  const channels = await guild.channels.fetch();
  const channel = channels.find((item) =>
    item?.type === ChannelType.GuildText
    && item.parentId === project.categoryId
    && item.name === DAILY_SCRUM_CHANNEL_NAME,
  );
  return channel instanceof TextChannel ? channel : null;
}

async function reminderAlreadySent(projectId: string, date: string): Promise<boolean> {
  const data = await readData();
  return data.reminderDates[projectId] === date;
}

async function markReminderSent(projectId: string, date: string): Promise<void> {
  await updateData((data) => {
    data.reminderDates[projectId] = date;
  });
}

export async function sendDailyScrumReminders(client: Client, now = new Date()): Promise<void> {
  const date = seoulDateKey(now);
  const projects = await listProjects();

  for (const project of projects) {
    try {
      if (await reminderAlreadySent(project.id, date)) continue;

      const guild = client.guilds.cache.get(project.guildId)
        ?? await client.guilds.fetch(project.guildId).catch(() => null);
      if (!guild) continue;

      const channel = await findDailyScrumChannel(guild, project);
      if (!channel) continue;

      await channel.send({
        content:
          "@everyone\n" +
          "🌅 **데일리 스크럼 작성 시간입니다.**\n" +
          "오늘 할 일은 `/scrum write todo:...`로 작성해주세요.\n" +
          "`did`를 비우면 전날 작성한 TODO가 자동으로 DID에 들어갑니다.",
        allowedMentions: { parse: ["everyone"] },
      });
      await markReminderSent(project.id, date);
    } catch (error) {
      console.error(`데일리 스크럼 알림 전송 실패 (${project.name})`, error);
    }
  }
}

function millisecondsUntilNextSeoulEight(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);

  let target = Date.UTC(
    year,
    month - 1,
    day,
    REMINDER_HOUR - SEOUL_OFFSET_HOURS,
    0,
    0,
    0,
  );

  if (target <= now.getTime()) target += DAY_MS;
  return Math.max(1_000, target - now.getTime());
}

export function startDailyScrumReminderScheduler(client: Client): void {
  const scheduleNext = () => {
    const delay = millisecondsUntilNextSeoulEight();
    setTimeout(async () => {
      try {
        await sendDailyScrumReminders(client);
      } finally {
        scheduleNext();
      }
    }, delay);
  };

  scheduleNext();
  console.log("데일리 스크럼 알림 예약: 매일 08:00 (Asia/Seoul)");
}
