import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertProjectModelId } from "../project-model/contracts.js";
import type { DiscordProjectBinding } from "./contracts.js";

export type CreateDiscordProjectBindingInput = {
  guildId: string;
  storedProjectId: string;
  projectId: string;
  defaultNodeId: string;
  at: string;
};

function bindingFile(root: string, guildId: string, storedProjectId: string): string {
  assertProjectModelId(guildId);
  assertProjectModelId(storedProjectId);
  return resolve(
    root,
    "discord-project-bindings",
    guildId,
    `${storedProjectId}.json`,
  );
}

async function readBinding(path: string): Promise<DiscordProjectBinding | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as DiscordProjectBinding;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeBinding(path: string, binding: DiscordProjectBinding): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(binding, null, 2), "utf8");
  await rename(temporary, path);
}

export async function loadDiscordProjectBinding(
  root: string,
  guildId: string,
  storedProjectId: string,
): Promise<DiscordProjectBinding | null> {
  return readBinding(bindingFile(root, guildId, storedProjectId));
}

export async function createDiscordProjectBinding(
  root: string,
  input: CreateDiscordProjectBindingInput,
): Promise<DiscordProjectBinding> {
  assertProjectModelId(input.projectId);
  assertProjectModelId(input.defaultNodeId);
  const path = bindingFile(root, input.guildId, input.storedProjectId);
  const existing = await readBinding(path);
  if (existing) {
    if (
      existing.projectId !== input.projectId
      || existing.defaultNodeId !== input.defaultNodeId
    ) {
      throw new Error(
        `Discord project binding already exists; explicit rebind required: ${input.storedProjectId}`,
      );
    }
    return existing;
  }

  const binding: DiscordProjectBinding = {
    version: 1,
    guildId: input.guildId,
    storedProjectId: input.storedProjectId,
    projectId: input.projectId,
    defaultNodeId: input.defaultNodeId,
    createdAt: input.at,
    updatedAt: input.at,
  };
  await writeBinding(path, binding);
  return binding;
}

export async function deleteDiscordProjectBinding(
  root: string,
  guildId: string,
  storedProjectId: string,
): Promise<boolean> {
  const path = bindingFile(root, guildId, storedProjectId);
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
