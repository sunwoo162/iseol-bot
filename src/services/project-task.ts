import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type ProjectTaskStatus = "open" | "completed";
export type ProjectTaskRepositorySide = "frontend" | "backend";

export type StoredProjectTask = {
  id: string;
  projectId: string;
  guildId: string;
  creatorDiscordId: string;
  githubUsername?: string;
  repositorySide: ProjectTaskRepositorySide;
  repository: string;
  issueNumber: number;
  issueUrl: string;
  calendarEventId?: string;
  discordChannelId?: string;
  discordMessageId?: string;
  title: string;
  body: string;
  start: string;
  end: string;
  status: ProjectTaskStatus;
  createdAt: string;
  updatedAt: string;
};

const DATA_FILE = resolve(process.cwd(), "data", "project-tasks.json");

async function readTasks(): Promise<StoredProjectTask[]> {
  try {
    const content = await readFile(DATA_FILE, "utf8");
    return JSON.parse(content) as StoredProjectTask[];
  } catch {
    return [];
  }
}

async function writeTasks(tasks: StoredProjectTask[]): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(tasks, null, 2), "utf8");
}

export async function saveProjectTask(
  input: Omit<StoredProjectTask, "id" | "createdAt" | "updatedAt">,
): Promise<StoredProjectTask> {
  const tasks = await readTasks();
  const now = new Date().toISOString();
  const stored: StoredProjectTask = {
    ...input,
    id: randomBytes(6).toString("hex"),
    createdAt: now,
    updatedAt: now,
  };
  tasks.push(stored);
  await writeTasks(tasks);
  return stored;
}

export async function findProjectTask(id: string): Promise<StoredProjectTask | null> {
  const tasks = await readTasks();
  return tasks.find((task) => task.id === id) ?? null;
}

export async function updateProjectTask(
  id: string,
  updates: Partial<Omit<StoredProjectTask, "id" | "createdAt">>,
): Promise<StoredProjectTask | null> {
  const tasks = await readTasks();
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return null;

  const current = tasks[index];
  if (!current) return null;

  const updated: StoredProjectTask = {
    ...current,
    ...updates,
    id,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  tasks[index] = updated;
  await writeTasks(tasks);
  return updated;
}

export async function listProjectTasks(guildId: string, projectId: string): Promise<StoredProjectTask[]> {
  const tasks = await readTasks();
  return tasks.filter((task) => task.guildId === guildId && task.projectId === projectId);
}

export async function listMemberProjectTasks(
  guildId: string,
  projectId: string,
  discordUserId: string,
): Promise<StoredProjectTask[]> {
  const tasks = await listProjectTasks(guildId, projectId);
  return tasks.filter((task) => task.creatorDiscordId === discordUserId);
}
