import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRuntimeLock, loadRuntimeHostConfig } from "../scripts/iseol-runtime-host.js";

test("runtime host loads explicit roots and derives a durable lock path", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-"));
  const file = join(root, "runtime.json");
  await writeFile(file, JSON.stringify({ dataRoot: root, modelRoot: join(root, "model"), runRoot: join(root, "runs"), webWorkerRoot: join(root, "workers"), browserProfileRoot: join(root, "profile") }));
  const config = loadRuntimeHostConfig(file);
  assert.equal(config.dataRoot, root);
  assert.equal(config.lockPath, join(root, "runtime", "iseol-runtime.lock"));
});

test("runtime host lock prevents concurrent ownership and releases cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-lock-"));
  const path = join(root, "runtime.lock");
  const release = await acquireRuntimeLock(path);
  await assert.rejects(acquireRuntimeLock(path), /already owns/);
  await release();
  const releaseAgain = await acquireRuntimeLock(path);
  await releaseAgain();
});
