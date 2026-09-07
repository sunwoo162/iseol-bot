import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ProjectWorkspace } from "./contracts.js";
import { assertProjectModelId } from "./contracts.js";

function workspaceFile(root: string, id: string): string {
  assertProjectModelId(id);
  return resolve(root, "projects", id, "project.json");
}

export async function saveProjectWorkspace(
  root: string,
  workspace: ProjectWorkspace,
): Promise<void> {
  assertProjectModelId(workspace.id);
  const path = workspaceFile(root, workspace.id);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(workspace, null, 2), "utf8");
  await rename(temp, path);
}

export async function loadProjectWorkspace(
  root: string,
  id: string,
): Promise<ProjectWorkspace | null> {
  const path = workspaceFile(root, id);
  try {
    return JSON.parse(await readFile(path, "utf8")) as ProjectWorkspace;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function listProjectWorkspaces(
  root: string,
): Promise<ProjectWorkspace[]> {
  const directory = resolve(root, "projects");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const workspaces: ProjectWorkspace[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    try { assertProjectModelId(id); } catch { continue; }
    const workspace = await loadProjectWorkspace(root, id);
    if (workspace) workspaces.push(workspace);
  }
  return workspaces.sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}
