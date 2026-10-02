import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (name: string) => readFile(new URL(name, root), "utf8");

test("repository exposes open source governance documents", async () => {
  for (const file of ["LICENSE", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"]) {
    assert.equal(existsSync(new URL(file, root)), true, `${file} must exist`);
  }
  assert.match(await read("LICENSE"), /GNU AFFERO GENERAL PUBLIC LICENSE/i);
  assert.match(await read("SECURITY.md"), /vulnerabilit|보안/i);
});

test("package metadata is publishable and README describes the current product", async () => {
  const packageJson = JSON.parse(await read("package.json")) as { private?: boolean; license?: string };
  assert.notEqual(packageJson.private, true);
  assert.equal(packageJson.license, "AGPL-3.0-only");
  const readme = await read("README.md");
  assert.match(readme, /셀프호스팅|self-host/i);
  assert.match(readme, /Docker/i);
  assert.match(readme, /환경변수|environment/i);
  assert.match(readme, /Broadcast Room|방송실/);
});
