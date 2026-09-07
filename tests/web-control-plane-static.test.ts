import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "web");

async function webFile(name: string): Promise<string> {
  return readFile(resolve(root, name), "utf8");
}

test("dashboard exposes the two Iseol Web modes and auth controls", async () => {
  const html = await webFile("index.html");
  assert.match(html, /Idea Lab/);
  assert.match(html, /Project Workspace/);
  assert.match(html, /data-mode="idea-lab"/);
  assert.match(html, /data-mode="project-workspace"/);
  assert.match(html, /id="web-token"/);
  assert.match(html, /id="save-token"/);
});

test("dashboard declares prototype and Project Workspace rendering targets", async () => {
  const html = await webFile("index.html");
  assert.match(html, /id="prototype-grid"/);
  assert.match(html, /id="project-select"/);
  assert.match(html, /id="genesis-panel"/);
  assert.match(html, /id="project-tree"/);
  assert.match(html, /id="project-runs"/);
  assert.match(html, /id="project-history"/);
});

test("browser script supports deployment opening promotion and workspace rendering", async () => {
  const script = await webFile("app.js");
  assert.match(script, /\/api\/idea-lab/);
  assert.match(script, /\/api\/prototypes\//);
  assert.match(script, /\/promote/);
  assert.match(script, /\/api\/projects\//);
  assert.match(script, /localStorage/);
  assert.match(script, /Authorization/);
  assert.match(script, /deployment/);
  assert.match(script, /genesis/);
  assert.match(script, /history/);
  assert.match(script, /runs/);
});

test("static assets include responsive loading empty unauthorized and error states", async () => {
  const html = await webFile("index.html");
  const script = await webFile("app.js");
  const styles = await webFile("styles.css");
  assert.match(html, /id="status-banner"/);
  assert.match(script, /loading/i);
  assert.match(script, /empty/i);
  assert.match(script, /unauthorized/i);
  assert.match(script, /error/i);
  assert.match(styles, /@media/);
  assert.equal(`${html}${script}${styles}`.includes("ISEOL_WEB_TOKEN="), false);
});
