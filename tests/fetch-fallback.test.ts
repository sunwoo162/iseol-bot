import assert from "node:assert/strict";
import test from "node:test";
import { buildAllconCurlArgs, isAllconUrl } from "../src/services/fetch-fallback.js";

test("Allcon fallback accepts only HTTPS canonical hosts", () => {
  assert.equal(isAllconUrl("https://all-con.co.kr/list/contest"), true);
  assert.equal(isAllconUrl("https://www.all-con.co.kr/list/contest"), true);

  for (const value of [
    null,
    "http://www.all-con.co.kr/list/contest",
    "https://api.all-con.co.kr/list/contest",
    "https://www.all-con.co.kr.attacker.example/list/contest",
    "https://www.all-con.co.kr@attacker.example/list/contest",
    "https://www.all-con.co.kr:444/list/contest",
    "https://www.all-con.co.kr\\@attacker.example/list/contest",
    "not-a-url",
  ]) {
    assert.equal(isAllconUrl(value), false, value ?? "null");
  }
});

test("Allcon curl fallback never follows an unvalidated redirect", () => {
  const args = buildAllconCurlArgs("https://www.all-con.co.kr/list/contest", {
    headers: { "X-Test": "yes" },
  });

  assert.equal(args.includes("--location"), false);
  assert.deepEqual(args.slice(args.indexOf("--max-redirs"), args.indexOf("--max-redirs") + 2), ["--max-redirs", "0"]);
  assert.equal(args.at(-1), "https://www.all-con.co.kr/list/contest");
  assert.equal(args.includes("--insecure"), true);
  assert.equal(args.includes("x-test: yes"), true);
  assert.equal(args.some((value) => value.includes("%{http_code}")), true);
});

test("Allcon curl fallback rejects a URL outside its allowlist before spawning curl", () => {
  assert.throws(
    () => buildAllconCurlArgs("https://attacker.example/redirect"),
    /Allcon fallback URL is not allowed/,
  );
});
