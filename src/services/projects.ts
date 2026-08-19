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

export async function findProject(id: string): Promise<StoredProject | null> {
  const projects = await readProjects();
  return projects.find((project) => project.id === id) ?? null;
}
