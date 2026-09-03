export type DoctorInput = {
  env: Record<string, string | undefined>;
  hasStoredGoogleRefreshToken: boolean;
};

export type DoctorReport = {
  text: string;
  coreReady: boolean;
  exitCode: 0 | 1;
};

const CORE_CHECKS = [
  ["DISCORD_TOKEN", "Discord Token"],
  ["DISCORD_CLIENT_ID", "Discord Client ID"],
  ["GITHUB_TOKEN", "GitHub Token"],
  ["FIGMA_TOKEN", "Figma Token"],
  ["NOTION_TOKEN", "Notion Token"],
] as const;

function has(env: Record<string, string | undefined>, key: string): boolean {
  return Boolean(env[key]?.trim());
}

function status(ok: boolean, label: string, missing = "누락"): string {
  return ok ? `✅ ${label} · 준비됨` : `❌ ${label} · ${missing}`;
}

export function buildDoctorReport(input: DoctorInput): DoctorReport {
  const { env } = input;
  const coreLines = CORE_CHECKS.map(([key, label]) => status(has(env, key), label));
  const coreReady = CORE_CHECKS.every(([key]) => has(env, key));

  const googleClientReady = has(env, "GOOGLE_CLIENT_ID") && has(env, "GOOGLE_CLIENT_SECRET");
  const callbackReady = has(env, "PUBLIC_BASE_URL") || has(env, "GOOGLE_REDIRECT_URI");
  const authorized = has(env, "GOOGLE_REFRESH_TOKEN") || input.hasStoredGoogleRefreshToken;
  const googleReadyForAuthorization = googleClientReady && callbackReady;

  const googleLines: string[] = [];
  if (!googleClientReady && !callbackReady && !authorized) {
    googleLines.push("⚪ Google Calendar · 선택 설정");
    googleLines.push("   사용하려면 OAuth Client와 공개 callback URL을 설정하세요.");
  } else {
    googleLines.push(status(googleClientReady, "OAuth Client"));
    googleLines.push(status(callbackReady, "OAuth callback"));
    if (authorized) {
      googleLines.push("✅ Google authorization · 연결됨");
    } else if (googleReadyForAuthorization) {
      googleLines.push("🟡 Google authorization · Discord에서 1회 연결하세요");
    } else {
      googleLines.push("⚪ Google authorization · OAuth 기본 설정 후 Discord에서 연결");
    }
  }

  const reviewLines = [
    has(env, "GITHUB_TOKEN") ? "✅ GitHub Code Review · 토큰 설정됨" : "❌ GitHub Code Review · GitHub Token 누락",
    "ℹ️ 저장소 권한 · Workflows / Pull requests / Webhooks Read/write 확인",
  ];

  const summary = coreReady
    ? "✅ Core · 준비 완료"
    : "❌ Core · 필수 설정을 먼저 완료하세요";

  return {
    coreReady,
    exitCode: coreReady ? 0 : 1,
    text: [
      "🩺 Iseol Setup Doctor",
      "",
      "**Core**",
      ...coreLines,
      "",
      "**Google Calendar**",
      ...googleLines,
      "",
      "**GitHub Code Review**",
      ...reviewLines,
      "",
      "**Result**",
      summary,
      coreReady ? "ℹ️ 선택 연동은 나중에 Discord의 ⚡ 연동 도우미에서 마무리할 수 있습니다." : "ℹ️ .env의 누락 항목을 채운 뒤 `npm run doctor`를 다시 실행하세요.",
    ].join("\n"),
  };
}
