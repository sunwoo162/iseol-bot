import assert from "node:assert/strict";
import test from "node:test";
import { formatProjectRepairResult } from "../src/services/project-experience/project-admin-runtime.js";

test("repair result copy is compact and never exposes raw internal errors", () => {
  const text = formatProjectRepairResult({
    repaired: ["Discord 프로젝트 패널", "Code Review · rain-gj/frontend"],
    unchanged: ["Code Review · rain-gj/backend"],
    needsAdmin: ["Code Review · rain-gj/private"],
    failed: ["Discord 프로젝트 패널"],
  });

  assert.match(text, /복구됨/);
  assert.match(text, /변경 없음/);
  assert.match(text, /관리자 설정 필요/);
  assert.match(text, /실패/);
  assert.ok(!/403|token|PAT|Resource not accessible/i.test(text));
});
