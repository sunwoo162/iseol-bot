import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { integrationHealthPayload } from "../src/services/webhook-server.js";

test("integration health payload is stable and does not expose configuration", () => {
  assert.deepEqual(integrationHealthPayload(), {
    ok: true,
    service: "iseol",
  });
});

test("production image has an HTTP healthcheck against healthz", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /127\.0\.0\.1:8787\/healthz/);
});

test("integration server source keeps healthz available independently of optional integrations", async () => {
  const source = await readFile("src/services/webhook-server.ts", "utf8");
  assert.match(source, /path === "\/healthz"/);
  assert.ok(!/if \(!googleEnabled && !githubEnabled\) \{[\s\S]{0,200}?return;/.test(source));
});
