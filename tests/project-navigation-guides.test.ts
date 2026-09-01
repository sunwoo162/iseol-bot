import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarPinnedGuide,
  discordMessageUrl,
  documentPinnedGuide,
  projectHubPinnedGuide,
} from "../src/services/project-experience/project-navigation-guides.js";
import type { StoredProject } from "../src/services/projects.js";

const project: StoredProject = {
  id: "p1",
  name: "Rain GJ",
  guildId: "guild1",
  categoryId: "category1",
  organization: "rain-gj",
  frontend: { owner: "rain-gj", repo: "frontend", url: "https://github.com/rain-gj/frontend" },
  backend: { owner: "rain-gj", repo: "backend", url: "https://github.com/rain-gj/backend" },
  calendarUrl: "https://calendar.google.com/calendar/u/0/r?cid=rain",
  notionUrl: "https://www.notion.so/rain-gj",
  figmaUrl: "https://www.figma.com/design/rain-gj",
};

function componentCount(payload: { components?: unknown[] }): number {
  return payload.components?.length ?? 0;
}

test("discord message urls target the original live message", () => {
  assert.equal(
    discordMessageUrl("guild1", "channel1", "message1"),
    "https://discord.com/channels/guild1/channel1/message1",
  );
});

test("pinned project hub guide is navigation-only", () => {
  const hubUrl = discordMessageUrl("guild1", "hub-channel", "hub-message");
  const payload = projectHubPinnedGuide(project, hubUrl);
  assert.equal(componentCount(payload), 0);
  assert.match(payload.embeds[0]?.data.description ?? "", /프로젝트 허브/);
  assert.match(payload.embeds[0]?.data.description ?? "", /hub-message/);
});

test("pinned calendar guide hides CRUD actions behind the live hub", () => {
  const hubUrl = discordMessageUrl("guild1", "hub-channel", "hub-message");
  const payload = calendarPinnedGuide(project, hubUrl);
  assert.equal(componentCount(payload), 0);
  const description = payload.embeds[0]?.data.description ?? "";
  assert.match(description, /작업 만들기/);
  assert.match(description, /더보기/);
  assert.match(description, /calendar\.google\.com/);
});

test("pinned notion and figma guides use links without discord components", () => {
  const notion = documentPinnedGuide(project, "notion", "https://discord.com/channels/g/c/m");
  const figma = documentPinnedGuide(project, "figma", "https://discord.com/channels/g/c/m");
  assert.equal(componentCount(notion), 0);
  assert.equal(componentCount(figma), 0);
  assert.match(notion.embeds[0]?.data.description ?? "", /notion\.so/);
  assert.match(figma.embeds[0]?.data.description ?? "", /figma\.com/);
});
