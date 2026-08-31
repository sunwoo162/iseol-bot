import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type CalendarMapping = {
  externalKey: string;
  projectId: string;
  calendarId: string;
  eventId: string;
  source: "issue" | "milestone" | "discord";
  repository?: string;
  number?: number;
};

export function calendarExternalKey(projectId: string, repository: string, source: string, number: number): string {
  return `${projectId}:${repository.toLowerCase()}:${source}:${number}`;
}

export class CalendarStateStore {
  constructor(private readonly file = resolve(process.cwd(), "data", "calendar-state.json")) {}

  private async read(): Promise<CalendarMapping[]> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as CalendarMapping[];
    } catch {
      return [];
    }
  }

  private async write(items: CalendarMapping[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify(items, null, 2), "utf8");
    await rename(temp, this.file);
  }

  async find(externalKey: string): Promise<CalendarMapping | null> {
    return (await this.read()).find((item) => item.externalKey === externalKey) ?? null;
  }

  async upsert(mapping: CalendarMapping): Promise<void> {
    const items = await this.read();
    const index = items.findIndex((item) => item.externalKey === mapping.externalKey);
    if (index >= 0) items[index] = mapping;
    else items.push(mapping);
    await this.write(items);
  }

  async removeProject(projectId: string): Promise<number> {
    const items = await this.read();
    const next = items.filter((item) => item.projectId !== projectId);
    const removed = items.length - next.length;
    if (removed > 0) await this.write(next);
    return removed;
  }
  async remove(externalKey: string): Promise<boolean> {
    const items = await this.read();
    const next = items.filter((item) => item.externalKey !== externalKey);
    if (next.length === items.length) return false;
    await this.write(next);
    return true;
  }
}
