import assert from "node:assert/strict";
import test from "node:test";
import { formatUserFacingError } from "../src/security/user-error.js";

test("formatUserFacingError redacts credentials and keeps user-facing text on one line", () => {
  const result = formatUserFacingError(new Error("token=super-secret\nnext line"));

  assert.equal(result, "token=[redacted] next line");
  assert.doesNotMatch(result, /super-secret/);
  assert.doesNotMatch(result, /[\r\n]/);
});

test("formatUserFacingError uses and sanitizes the fallback for non-errors", () => {
  assert.equal(formatUserFacingError({ token: "ignored" }, "fallback token=secret"), "fallback token=[redacted]");
});
