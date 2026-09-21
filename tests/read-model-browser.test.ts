import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright-core";
import { startWebControlPlaneServer } from "../src/web-control-plane/server.js";
import { readModelFixture } from "./support/read-model-fixture.js";

test("authenticated browser selects an existing workspace, promotes across roots, returns to selections, and distinguishes list errors", async t => {
  const executablePath = process.env.ISEOL_TEST_BROWSER ?? [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find(existsSync);
  assert.ok(executablePath, "Set ISEOL_TEST_BROWSER to an installed test browser; no production profile is used");
  const f = await readModelFixture();
  const server = await startWebControlPlaneServer({ ...f, host: "127.0.0.1", port: 0, token: "synthetic-browser-token", webRoot: resolve("web") });
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1100, height: 820 } });
  const page = await context.newPage();
  // Only synthetic local requests: never open the example preview or external accounts.
  await context.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await page.goto(base);
  await page.locator("#web-token").fill("synthetic-browser-token");
  await page.locator("#save-token").click();
  const listResponse = page.waitForResponse(r => r.url() === base + "/api/projects");
  await page.locator('[data-mode="project-workspace"]').click();
  assert.equal((await listResponse).status(), 200);
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLOptionElement>("#project-select option")).some(x => x.value === "workspace-existing"));
  await page.locator("#project-select").selectOption("workspace-existing");
  await page.waitForFunction(() => document.querySelector("#status-banner")?.textContent?.includes("Project Workspace loaded:"));
  assert.match(await page.locator("#project-content").innerText(), /Existing workspace/);
  await page.locator('[data-mode="idea-lab"]').click();
  await page.getByRole("button", { name: "Open campaign", exact: true }).first().click();
  await page.locator("#campaign-detail-content h3").first().waitFor();
  assert.match(await page.locator("#campaign-detail").innerText(), /WAITING_EXTERNAL/);
  await page.locator("#close-campaign-detail").click();
  await page.getByRole("button", { name: "Details", exact: true }).first().click();
  await page.locator("#prototype-detail-content h3").waitFor();
  assert.match(await page.locator("#prototype-detail").innerText(), /campaign-fixture/);
  await page.locator("#close-prototype-detail").click();
  await page.getByRole("button", { name: "Promote to project", exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector("#status-banner")?.textContent?.includes("Promoted prototype-ready"));
  assert.equal(await page.locator('#project-select option[value="project-prototype-ready"]').count(), 1);
  await page.locator('[data-mode="idea-lab"]').click();
  await page.locator('[data-mode="project-workspace"]').click();
  assert.equal(await page.locator("#project-select").inputValue(), "project-prototype-ready");
  await page.route("**/api/projects", route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "fixture list failure" }) }));
  await page.locator("#refresh-project").click();
  await page.waitForFunction(() => document.querySelector("#project-list-status")?.textContent?.includes("fixture list failure"));
  assert.equal(await page.locator("#project-list-status").getAttribute("data-kind"), "error");
  await page.unroute("**/api/projects");
  await page.locator("#refresh-project").click();
  await page.waitForFunction(() => document.querySelector("#project-list-status")?.getAttribute("data-kind") === "success");
  await page.route("**/api/projects", route => route.fulfill({ status: 200, contentType: "application/json", body: '{"projects":[]}' }));
  await page.route("**/api/idea-lab", route => route.fulfill({ status: 200, contentType: "application/json", body: '{"campaigns":[],"productions":[],"prototypes":[]}' }));
  await page.reload();
  await page.locator('[data-mode="project-workspace"]').click();
  await page.waitForFunction(() => document.querySelector("#project-list-status")?.textContent?.includes("No projects"));
  assert.equal(await page.locator("#project-list-status").getAttribute("data-kind"), "empty");
  await context.clearCookies();
  await page.evaluate(() => localStorage.clear());
});
