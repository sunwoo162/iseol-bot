import assert from "node:assert/strict";
import test from "node:test";
import { buildDoctorReport } from "../src/setup/doctor.js";

const coreEnv = {
  DISCORD_TOKEN: "discord-super-secret",
  DISCORD_CLIENT_ID: "client-id",
  GITHUB_TOKEN: "github-super-secret",
  FIGMA_TOKEN: "figma-super-secret",
  NOTION_TOKEN: "notion-super-secret",
};

test("doctor fails when core configuration is missing and never prints secret values", () => {
  const report = buildDoctorReport({
    env: {
      ...coreEnv,
      GITHUB_TOKEN: "",
    },
    hasStoredGoogleRefreshToken: false,
  });

  assert.equal(report.exitCode, 1);
  assert.equal(report.coreReady, false);
  assert.match(report.text, /GitHub Token.*누락/);
  assert.ok(!report.text.includes("discord-super-secret"));
  assert.ok(!report.text.includes("figma-super-secret"));
  assert.ok(!report.text.includes("notion-super-secret"));
});

test("doctor treats optional integrations as non-fatal", () => {
  const report = buildDoctorReport({
    env: coreEnv,
    hasStoredGoogleRefreshToken: false,
  });

  assert.equal(report.exitCode, 0);
  assert.equal(report.coreReady, true);
  assert.match(report.text, /Core.*준비 완료/s);
  assert.match(report.text, /Google Calendar.*선택 설정/s);
});

test("doctor explains one-click google authorization when oauth client is ready", () => {
  const report = buildDoctorReport({
    env: {
      ...coreEnv,
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      PUBLIC_BASE_URL: "https://iseol.example.com",
    },
    hasStoredGoogleRefreshToken: false,
  });

  assert.equal(report.exitCode, 0);
  assert.match(report.text, /Discord.*1회.*연결/);
  assert.ok(!report.text.includes("google-secret"));
});

test("doctor recognizes stored or environment google authorization", () => {
  const stored = buildDoctorReport({
    env: {
      ...coreEnv,
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      PUBLIC_BASE_URL: "https://iseol.example.com",
    },
    hasStoredGoogleRefreshToken: true,
  });
  assert.match(stored.text, /Google authorization.*연결됨/);

  const environment = buildDoctorReport({
    env: {
      ...coreEnv,
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GOOGLE_REDIRECT_URI: "https://iseol.example.com/google/oauth/callback",
      GOOGLE_REFRESH_TOKEN: "refresh-super-secret",
    },
    hasStoredGoogleRefreshToken: false,
  });
  assert.match(environment.text, /Google authorization.*연결됨/);
  assert.ok(!environment.text.includes("refresh-super-secret"));
});

test("doctor accepts explicit google redirect uri without public base url", () => {
  const report = buildDoctorReport({
    env: {
      ...coreEnv,
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GOOGLE_REDIRECT_URI: "https://iseol.example.com/google/oauth/callback",
    },
    hasStoredGoogleRefreshToken: false,
  });

  assert.match(report.text, /OAuth callback.*준비됨/);
  assert.match(report.text, /Discord.*1회.*연결/);
});
