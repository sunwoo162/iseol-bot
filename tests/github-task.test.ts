import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIssueMutation } from "../src/services/github.js";

test("issue mutation payload keeps only explicit task fields", () => {
  assert.deepEqual(
    normalizeIssueMutation({
      title: "로그인 API 수정",
      body: undefined,
      state: "open",
    }),
    {
      title: "로그인 API 수정",
      state: "open",
    },
  );
});

test("issue completion normalizes to closed state", () => {
  assert.deepEqual(normalizeIssueMutation({ state: "closed" }), { state: "closed" });
});
