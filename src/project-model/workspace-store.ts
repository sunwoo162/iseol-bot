import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
