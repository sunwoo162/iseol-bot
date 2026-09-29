import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertIdentityId } from "../identity/contracts.js";
import type { DirectMessage, FriendRequest, SocialBlock, SocialProfile, SocialReport } from "./contracts.js";

function socialRoot(root: string): string { return resolve(root, "social"); }
function profilePath(root: string, userId: string): string { assertIdentityId(userId); return resolve(root, "users", userId, "social", "profile.json"); }
function friendshipPath(root: string, requestId: string): string { assertIdentityId(requestId); return resolve(socialRoot(root), "friendships", `${requestId}.json`); }
function messagePath(root: string, messageId: string): string { assertIdentityId(messageId); return resolve(socialRoot(root), "messages", `${messageId}.json`); }
function blockPath(root: string, blockerUserId: string, blockedUserId: string): string { assertIdentityId(blockerUserId); assertIdentityId(blockedUserId); return resolve(socialRoot(root), "blocks", `${blockerUserId}-${blockedUserId}.json`); }
function reportPath(root: string, reportId: string): string { assertIdentityId(reportId); return resolve(socialRoot(root), "reports", `${reportId}.json`); }
async function saveJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2), "utf8"); await rename(temporary, path); }
async function loadJson<T>(path: string): Promise<T | null> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
async function listJson<T>(directory: string): Promise<T[]> { let names: string[]; try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } const values: T[] = []; for (const name of names.filter((item) => item.endsWith(".json"))) { const value = await loadJson<T>(resolve(directory, name)); if (value) values.push(value); } return values; }

export const saveProfile = (root: string, value: SocialProfile) => saveJson(profilePath(root, value.userId), value);
export const loadProfile = (root: string, userId: string) => loadJson<SocialProfile>(profilePath(root, userId));
export const saveFriendRequest = (root: string, value: FriendRequest) => saveJson(friendshipPath(root, value.id), value);
export const loadFriendRequest = (root: string, requestId: string) => loadJson<FriendRequest>(friendshipPath(root, requestId));
export const listFriendRequests = (root: string) => listJson<FriendRequest>(resolve(socialRoot(root), "friendships"));
export const saveDirectMessage = (root: string, value: DirectMessage) => saveJson(messagePath(root, value.id), value);
export const listDirectMessages = (root: string) => listJson<DirectMessage>(resolve(socialRoot(root), "messages"));
export const saveBlock = (root: string, value: SocialBlock) => saveJson(blockPath(root, value.blockerUserId, value.blockedUserId), value);
export const loadBlock = (root: string, blockerUserId: string, blockedUserId: string) => loadJson<SocialBlock>(blockPath(root, blockerUserId, blockedUserId));
export const listBlocks = (root: string) => listJson<SocialBlock>(resolve(socialRoot(root), "blocks"));
export const saveReport = (root: string, value: SocialReport) => saveJson(reportPath(root, value.id), value);
export const listReports = (root: string) => listJson<SocialReport>(resolve(socialRoot(root), "reports"));
