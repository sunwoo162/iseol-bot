import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RepositoryRef } from "./github.js";

export type StoredProject = {
  id: string;
  name: string;
  guildId: string;
  categoryId: string;
  organization: string;
  frontend: RepositoryRef;
  backend: RepositoryRef;
  frontendHookId?: number;
  backendHookId?: number;
  figmaUrl?: string;
  figmaFileKey?: string;
  figmaChannelId?: string;
  figmaWebhookId?: string;
};

const DATA_FILE = resolve(process.cwd(), "data", "projects.json");

async function readProjects(): Promise<StoredProject[]> {
  try {
    const content = await readFile(DATA_FILE, "utf8");
    return JSON.parse(content) as StoredProject[];
  } catch {
    return [];
  }
}

async function writeProjects(projects: StoredProject[]): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(projects, null, 2), "utf8");
}

export async function saveProject(project: Omit<StoredProject, "id">): Promise<StoredProject> {
  const projects = await readProjects();
  const stored: StoredProject = { ...project, id: randomBytes(6).toString("hex") };
  projects.push(stored);
  await writeProjects(projects);
  return stored;
}

export async function updateProject(id: string, updates: Partial<Omit<StoredProject, "id">>): Promise<StoredProject | null> {
  const projects = await readProjects();
  const index = projects.findIndex((project) => project.id === id);
  if (index < 0) return null;

  const current = projects[index];
  if (!current) return null;

  const updated: StoredProject = { ...current, ...updates, id };
  projects[index] = updated;
  await writeProjects(projects);
  return updated;
}

export async function findProject(id: string): Promise<StoredProject | null> {
  const projects = await readProjects();
  return projects.find((project) => project.id === id) ?? null;
}

export async function findProjectByName(guildId: string, name: string): Promise<StoredProject | null> {
  const normalized = name.trim().toLowerCase();
  const projects = await readProjects();
  return projects.find((project) => project.guildId === guildId && project.name.trim().toLowerCase() === normalized) ?? null;
}

export async function findProjectByFigmaWebhook(webhookId: string, fileKey: string): Promise<StoredProject | null> {
  const projects = await readProjects();
  return projects.find((project) =>
    project.figmaWebhookId === webhookId
    || (!!project.figmaFileKey && project.figmaFileKey === fileKey),
  ) ?? null;
}

export async function deleteProject(id: string): Promise<boolean> {
  const projects = await readProjects();
  const next = projects.filter((project) => project.id !== id);
  if (next.length === projects.length) return false;

  await writeProjects(next);
  return true;
}
