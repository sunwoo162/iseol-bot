import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import {
  extractIseolReviewArtifactFromZip,
  selectIseolReviewRun,
  validateCiArtifactForPull,
} from "../src/services/review/github-ci-review.js";

function singleFileZip(name: string, text: string): Buffer {
  const filename = Buffer.from(name, "utf8");
  const raw = Buffer.from(text, "utf8");
  const compressed = deflateRawSync(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(filename.length, 26);
  local.writeUInt16LE(0, 28);
  const localEntry = Buffer.concat([local, filename, compressed]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt32LE(0, 42);
  const centralEntry = Buffer.concat([central, filename]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralEntry.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16);
  return Buffer.concat([localEntry, centralEntry, eocd]);
}

const artifact = {
  schemaVersion: 1 as const,
  repository: "org/repo",
  pullNumber: 4,
  headSha: "head123",
  generatedAt: new Date().toISOString(),
  checks: [],
  findings: [],
};

test("latest Iseol workflow run controls pending/completed state", () => {
  const pending = selectIseolReviewRun([
    { id: 10, name: "Iseol Code Review", headSha: "head123", status: "completed", conclusion: "success" },
    { id: 11, name: "Iseol Code Review", headSha: "head123", status: "in_progress", conclusion: null },
    { id: 12, name: "Other", headSha: "head123", status: "completed", conclusion: "success" },
  ], "head123");
  assert.deepEqual(pending, { state: "pending", runId: 11 });

  const completed = selectIseolReviewRun([
    { id: 13, name: "Iseol Code Review", headSha: "head123", status: "completed", conclusion: "failure" },
  ], "head123");
  assert.deepEqual(completed, { state: "completed", runId: 13, conclusion: "failure" });
});

test("review artifact zip extracts and validates repository pull and head sha", () => {
  const zip = singleFileZip("nested/iseol-review.json", JSON.stringify(artifact));
  const parsed = extractIseolReviewArtifactFromZip(zip);
  assert.equal(parsed.repository, "org/repo");
  assert.doesNotThrow(() => validateCiArtifactForPull(parsed, "org/repo", 4, "head123"));
  assert.throws(() => validateCiArtifactForPull(parsed, "org/repo", 4, "different"), /HEAD SHA/);
  assert.throws(() => validateCiArtifactForPull(parsed, "evil/repo", 4, "head123"), /저장소/);
});
