import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { resolve } from "node:path";
import { assertIdentityId } from "../identity/contracts.js";
import type { CommunityComment, CommunityPost, CommunityReport } from "./contracts.js";

async function saveJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2), "utf8"); await rename(temporary, path); }
async function loadJson<T>(path: string): Promise<T | null> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }

function postPath(root: string, postId: string): string { assertIdentityId(postId); return resolve(root, "community", "posts", `${postId}.json`); }
function likePath(root: string, postId: string, userId: string): string { assertIdentityId(postId); assertIdentityId(userId); return resolve(root, "community", "likes", postId, `${userId}.json`); }
function commentPath(root: string, postId: string, commentId: string): string { assertIdentityId(postId); assertIdentityId(commentId); return resolve(root, "community", "comments", postId, `${commentId}.json`); }
function reportPath(root: string, reportId: string): string { assertIdentityId(reportId); return resolve(root, "community", "reports", `${reportId}.json`); }
export const savePost = (root: string, post: CommunityPost) => saveJson(postPath(root, post.id), post);
export const loadPost = (root: string, postId: string) => loadJson<CommunityPost>(postPath(root, postId));
export async function listPosts(root: string): Promise<CommunityPost[]> { let names: string[]; try { names = await readdir(resolve(root, "community", "posts")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } const result: CommunityPost[] = []; for (const name of names.filter((item) => item.endsWith(".json"))) { const post = await loadJson<CommunityPost>(resolve(root, "community", "posts", name)); if (post) result.push(post); } return result; }
export const saveComment = (root: string, comment: CommunityComment) => saveJson(commentPath(root, comment.postId, comment.id), comment);
export const loadComment = (root: string, postId: string, commentId: string) => loadJson<CommunityComment>(commentPath(root, postId, commentId));
export async function listComments(root: string, postId: string): Promise<CommunityComment[]> { let names: string[]; try { names = await readdir(resolve(root, "community", "comments", postId)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } const result: CommunityComment[] = []; for (const name of names.filter((item) => item.endsWith(".json"))) { const comment = await loadJson<CommunityComment>(resolve(root, "community", "comments", postId, name)); if (comment) result.push(comment); } return result; }
export const saveReport = (root: string, report: CommunityReport) => saveJson(reportPath(root, report.id), report);
export async function listReports(root: string): Promise<CommunityReport[]> { let names: string[]; try { names = await readdir(resolve(root, "community", "reports")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } const result: CommunityReport[] = []; for (const name of names.filter((item) => item.endsWith(".json"))) { const report = await loadJson<CommunityReport>(resolve(root, "community", "reports", name)); if (report) result.push(report); } return result; }
export const hasLike = async (root: string, postId: string, userId: string): Promise<boolean> => Boolean(await loadJson<{ postId: string; userId: string }>(likePath(root, postId, userId)));
export const saveLike = (root: string, postId: string, userId: string) => saveJson(likePath(root, postId, userId), { postId, userId });
export async function removeLike(root: string, postId: string, userId: string): Promise<void> { const file = likePath(root, postId, userId); try { await unlink(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
export async function countLikes(root: string, postId: string): Promise<number> { try { return (await readdir(resolve(root, "community", "likes", postId))).filter((item) => item.endsWith(".json")).length; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; } }
