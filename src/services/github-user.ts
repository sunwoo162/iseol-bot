import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import type { RepositoryRef } from "./github.js";

const DATA_FILE = resolve(process.cwd(), "data", "github-users.json");
const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";

export type GitHubAccountLink = {
  guildId: string;
  discordUserId: string;
  githubLogin: string;
  connectedAt: string;
};

export type GitHubUserProfile = {
  login: string;
  name: string | null;
  avatarUrl: string;
  htmlUrl: string;
  bio: string | null;
  company: string | null;
  location: string | null;
  publicRepos: number;
  followers: number;
  following: number;
};

export type GitHubContributionDay = {
  date: string;
  contributionCount: number;
  contributionLevel: "NONE" | "FIRST_QUARTILE" | "SECOND_QUARTILE" | "THIRD_QUARTILE" | "FOURTH_QUARTILE";
  weekday: number;
};

export type GitHubContributionCalendar = {
  totalContributions: number;
  weeks: Array<{ contributionDays: GitHubContributionDay[] }>;
};

export type GitHubRepositoryEvent = {
  id: string;
  type: string | null;
  actor?: {
    login?: string;
  };
  created_at?: string | null;
  payload?: {
    ref?: string;
    commits?: Array<{
      sha: string;
      message: string;
      distinct?: boolean;
      author?: {
        name?: string;
        email?: string;
      };
    }>;
  };
};

type GitHubUserApiResponse = {
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
  bio: string | null;
  company: string | null;
  location: string | null;
  public_repos: number;
  followers: number;
  following: number;
};

type ContributionGraphQlResponse = {
  data?: {
    user?: {
      contributionsCollection?: {
        contributionCalendar?: GitHubContributionCalendar;
      };
    } | null;
  };
  errors?: Array<{ message?: string }>;
};

async function readLinks(): Promise<GitHubAccountLink[]> {
  try {
    return JSON.parse(await readFile(DATA_FILE, "utf8")) as GitHubAccountLink[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeLinks(links: GitHubAccountLink[]): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(links, null, 2), "utf8");
}

export async function linkGitHubAccount(
  guildId: string,
  discordUserId: string,
  githubLogin: string,
): Promise<GitHubAccountLink> {
  const links = await readLinks();
  const normalized = githubLogin.trim();
  const existingIndex = links.findIndex((link) => link.guildId === guildId && link.discordUserId === discordUserId);
  const next: GitHubAccountLink = {
    guildId,
    discordUserId,
    githubLogin: normalized,
    connectedAt: new Date().toISOString(),
  };

  if (existingIndex >= 0) links[existingIndex] = next;
  else links.push(next);

  await writeLinks(links);
  return next;
}

export async function unlinkGitHubAccount(guildId: string, discordUserId: string): Promise<GitHubAccountLink | null> {
  const links = await readLinks();
  const existing = links.find((link) => link.guildId === guildId && link.discordUserId === discordUserId) ?? null;
  if (!existing) return null;

  await writeLinks(links.filter((link) => !(link.guildId === guildId && link.discordUserId === discordUserId)));
  return existing;
}

export async function findGitHubAccount(guildId: string, discordUserId: string): Promise<GitHubAccountLink | null> {
  const links = await readLinks();
  return links.find((link) => link.guildId === guildId && link.discordUserId === discordUserId) ?? null;
}

export async function listGitHubAccounts(guildId?: string): Promise<GitHubAccountLink[]> {
  const links = await readLinks();
  return guildId ? links.filter((link) => link.guildId === guildId) : links;
}

export class GitHubUserService {
  constructor(private readonly token: string) {}

  private headers(contentType = false): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "IseolBot/1.0",
      ...(contentType ? { "Content-Type": "application/json" } : {}),
    };
  }

  async getProfile(username: string): Promise<GitHubUserProfile> {
    const response = await fetch(`${GITHUB_API}/users/${encodeURIComponent(username)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      if (response.status === 404) throw new Error("GitHub 사용자를 찾을 수 없습니다.");
      throw new Error(`GitHub 사용자 조회 실패 (HTTP ${response.status})`);
    }

    const user = await response.json() as GitHubUserApiResponse;
    return {
      login: user.login,
      name: user.name,
      avatarUrl: user.avatar_url,
      htmlUrl: user.html_url,
      bio: user.bio,
      company: user.company,
      location: user.location,
      publicRepos: user.public_repos,
      followers: user.followers,
      following: user.following,
    };
  }

  async getContributionCalendar(username: string): Promise<GitHubContributionCalendar> {
    const query = `
      query($login: String!) {
        user(login: $login) {
          contributionsCollection {
            contributionCalendar {
              totalContributions
              weeks {
                contributionDays {
                  date
                  contributionCount
                  contributionLevel
                  weekday
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(GITHUB_GRAPHQL, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ query, variables: { login: username } }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) throw new Error(`GitHub 잔디 조회 실패 (HTTP ${response.status})`);
    const body = await response.json() as ContributionGraphQlResponse;
    if (body.errors?.length) {
      throw new Error(body.errors.map((error) => error.message || "GraphQL 오류").join(", "));
    }

    const calendar = body.data?.user?.contributionsCollection?.contributionCalendar;
    if (!calendar) throw new Error("GitHub 잔디 정보를 불러올 수 없습니다.");
    return calendar;
  }

  async listRepositoryEvents(repository: RepositoryRef): Promise<GitHubRepositoryEvent[]> {
    const response = await fetch(
      `${GITHUB_API}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/events?per_page=100`,
      {
        headers: this.headers(),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) throw new Error(`GitHub 저장소 이벤트 조회 실패 (${repository.owner}/${repository.repo}, HTTP ${response.status})`);
    return await response.json() as GitHubRepositoryEvent[];
  }
}

const LEVEL_COLORS: Record<GitHubContributionDay["contributionLevel"], string> = {
  NONE: "#161b22",
  FIRST_QUARTILE: "#0e4429",
  SECOND_QUARTILE: "#006d32",
  THIRD_QUARTILE: "#26a641",
  FOURTH_QUARTILE: "#39d353",
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function renderGitHubGrass(
  calendar: GitHubContributionCalendar,
  displayName: string,
): Promise<Buffer> {
  const cell = 14;
  const gap = 4;
  const gridX = 74;
  const gridY = 54;
  const weeks = calendar.weeks.slice(-53);
  const width = Math.max(1080, gridX + weeks.length * (cell + gap) + 36);
  const height = 235;
  const rects: string[] = [];
  const monthLabels: string[] = [];
  let previousMonth = -1;

  weeks.forEach((week, weekIndex) => {
    week.contributionDays.forEach((day) => {
      const x = gridX + weekIndex * (cell + gap);
      const y = gridY + day.weekday * (cell + gap);
      const color = LEVEL_COLORS[day.contributionLevel] ?? LEVEL_COLORS.NONE;
      rects.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${color}"/>`);

      const date = new Date(`${day.date}T00:00:00Z`);
      if (day.weekday === 0 && date.getUTCMonth() !== previousMonth && date.getUTCDate() <= 7) {
        previousMonth = date.getUTCMonth();
        const label = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
        monthLabels.push(`<text x="${x}" y="38" fill="#8b949e" font-size="14">${escapeXml(label)}</text>`);
      }
    });
  });

  const svg = `
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" rx="16" fill="#0d1117"/>
    <text x="24" y="28" fill="#f0f6fc" font-size="19" font-weight="700">${escapeXml(displayName)} · GitHub 잔디</text>
    ${monthLabels.join("")}
    <text x="24" y="82" fill="#8b949e" font-size="13">Mon</text>
    <text x="24" y="118" fill="#8b949e" font-size="13">Wed</text>
    <text x="24" y="154" fill="#8b949e" font-size="13">Fri</text>
    ${rects.join("")}
    <text x="24" y="211" fill="#8b949e" font-size="14">최근 1년 기여 ${calendar.totalContributions.toLocaleString("en-US")}회</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
