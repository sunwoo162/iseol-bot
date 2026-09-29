import { resolve } from "node:path";
import type { PrototypeProduction } from "./contracts.js";
import { assertIdeaLabId, assertPrototypeProduction } from "./contracts.js";
import { ideaLabDirectory, listIdeaLabJsonFiles, readIdeaLabJson, writeIdeaLabJsonAtomic } from "./store-utils.js";

function productionFile(root: string, id: string): string {
  assertIdeaLabId(id);
  return resolve(ideaLabDirectory(root, "productions"), `${id}.json`);
}

export async function savePrototypeProduction(root: string, production: PrototypeProduction): Promise<void> {
  assertPrototypeProduction(production);
  await writeIdeaLabJsonAtomic(productionFile(root, production.id), production);
}

export async function loadPrototypeProduction(root: string, id: string): Promise<PrototypeProduction | null> {
  const value = await readIdeaLabJson<PrototypeProduction>(productionFile(root, id));
  if (value) assertPrototypeProduction(value);
  return value;
}

export async function listPrototypeProductions(root: string): Promise<PrototypeProduction[]> {
  const directory = ideaLabDirectory(root, "productions");
  const productions: PrototypeProduction[] = [];
  for (const name of await listIdeaLabJsonFiles(directory)) {
    const production = await loadPrototypeProduction(root, name.slice(0, -5));
    if (production) productions.push(production);
  }
  return productions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
