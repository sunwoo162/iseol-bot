import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { assertIdentityId } from "../identity/contracts.js";
import type { AiChatConversation } from "./contracts.js";

function directory(root: string, userId: string): string { assertIdentityId(userId); return resolve(root, "users", userId, "ai-chat", "conversations"); }
function pathFor(root: string, userId: string, conversationId: string): string { assertIdentityId(conversationId); return resolve(directory(root, userId), `${conversationId}.json`); }
async function saveJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2), "utf8"); await rename(temporary, path); }
async function loadJson<T>(path: string): Promise<T | null> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
export const saveConversation = (root: string, conversation: AiChatConversation) => saveJson(pathFor(root, conversation.userId, conversation.id), conversation);
export const loadConversation = (root: string, userId: string, conversationId: string) => loadJson<AiChatConversation>(pathFor(root, userId, conversationId));
export async function listConversations(root: string, userId: string): Promise<AiChatConversation[]> { let names: string[]; try { names = await readdir(directory(root, userId)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } const values: AiChatConversation[] = []; for (const name of names.filter((item) => item.endsWith(".json"))) { const value = await loadJson<AiChatConversation>(resolve(directory(root, userId), name)); if (value) values.push(value); } return values; }
