import assert from "node:assert/strict";
import test from "node:test";
import { createContestSnapshotCache, normalizeContestCandidateUrl, type Contest } from "../src/services/contests.js";

const sourceUrl = "https://www.all-con.co.kr";
const contest: Contest = {
  title: "청소년 AI 공모전",
  url: "https://www.all-con.co.kr/view/contest/123",
  sources: ["올콘"],
  field: "인공지능",
  attachments: [{ name: "요강", url: "https://www.all-con.co.kr/notice.pdf" }],
};

test("contest snapshot cache coalesces discovery, isolates consumer mutations, and expires", async () => {
  let now = 100;
  let calls = 0;
  const getSnapshot = createContestSnapshotCache(async () => { calls++; return [contest]; }, 50, () => now);

  const [first, concurrent] = await Promise.all([getSnapshot(), getSnapshot()]);
  assert.equal(calls, 1);
  first[0]!.sources.push("위비티");
  first[0]!.attachments[0]!.name = "변경됨";

  const cached = await getSnapshot();
  assert.equal(calls, 1);
  assert.deepEqual(cached[0]!.sources, ["올콘"]);
  assert.equal(cached[0]!.attachments[0]!.name, "요강");
  assert.deepEqual(concurrent[0]!.sources, ["올콘"]);

  now = 150;
  await getSnapshot();
  assert.equal(calls, 2);
});

test("failed contest discovery is not cached", async () => {
  let calls = 0;
  const getSnapshot = createContestSnapshotCache(async () => {
    calls++;
    if (calls === 1) throw new Error("temporary scrape failure");
    return [contest];
  });

  await assert.rejects(getSnapshot(), /temporary scrape failure/);
  assert.deepEqual(await getSnapshot(), [contest]);
  assert.equal(calls, 2);
});

test("contest candidate URLs preserve the configured source origin", () => {
  assert.equal(
    normalizeContestCandidateUrl("/view/contest/123", sourceUrl),
    "https://www.all-con.co.kr/view/contest/123",
  );
  assert.equal(
    normalizeContestCandidateUrl("https://www.all-con.co.kr/view/contest/123", sourceUrl),
    "https://www.all-con.co.kr/view/contest/123",
  );
});

test("contest candidate URLs reject cross-origin and downgraded authorities", () => {
  for (const value of [
    "https://attacker.example/view/contest/123",
    "https://www.all-con.co.kr.attacker.example/view/contest/123",
    "https://www.all-con.co.kr@attacker.example/view/contest/123",
    "https://www.all-con.co.kr:444/view/contest/123",
    "http://www.all-con.co.kr/view/contest/123",
    "//attacker.example/view/contest/123",
    "javascript:alert(1)",
  ]) {
    assert.equal(normalizeContestCandidateUrl(value, sourceUrl), null, value);
  }
});
