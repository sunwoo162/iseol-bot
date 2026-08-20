import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ContestAttachment, ContestSource } from "./contests.js";

export type ContestVote = {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  title: string;
  url: string;
  sources?: ContestSource[];
  field?: string;
  target?: string;
  host?: string;
  sponsor?: string;
  period?: string;
  totalPrize?: string;
  firstPrize?: string;
  homepage?: string;
  attachments?: ContestAttachment[];
  status?: string;
  voterIds: string[];
  finalized: boolean;
  prepCategoryId?: string;
  createdAt: string;
};

const DATA_FILE = resolve(process.cwd(), "data", "contest-votes.json");

async function readVotes(): Promise<ContestVote[]> {
  try {
    const content = await readFile(DATA_FILE, "utf8");
    return JSON.parse(content) as ContestVote[];
  } catch {
    return [];
  }
}

async function writeVotes(votes: ContestVote[]): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(votes, null, 2), "utf8");
}

export function createContestVoteId(): string {
  return randomBytes(6).toString("hex");
}

export async function saveContestVote(vote: Omit<ContestVote, "createdAt">): Promise<ContestVote> {
  const votes = await readVotes();
  const stored: ContestVote = {
    ...vote,
    createdAt: new Date().toISOString(),
  };
  votes.push(stored);
  await writeVotes(votes);
  return stored;
}

export async function findContestVote(id: string): Promise<ContestVote | null> {
  const votes = await readVotes();
  return votes.find((vote) => vote.id === id) ?? null;
}

export async function updateContestVote(
  id: string,
  updates: Partial<Omit<ContestVote, "id" | "createdAt">>,
): Promise<ContestVote | null> {
  const votes = await readVotes();
  const index = votes.findIndex((vote) => vote.id === id);
  if (index < 0) return null;

  const current = votes[index];
  if (!current) return null;

  const updated: ContestVote = { ...current, ...updates, id: current.id, createdAt: current.createdAt };
  votes[index] = updated;
  await writeVotes(votes);
  return updated;
}
