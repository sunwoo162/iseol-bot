import "dotenv/config";
import { GoogleOAuthTokenStore } from "../services/calendar/google-oauth.js";
import { buildDoctorReport } from "./doctor.js";

async function main(): Promise<void> {
  const storedRefreshToken = await new GoogleOAuthTokenStore()
    .getRefreshToken()
    .catch(() => "");

  const report = buildDoctorReport({
    env: process.env,
    hasStoredGoogleRefreshToken: Boolean(storedRefreshToken),
  });

  console.log(report.text);
  process.exitCode = report.exitCode;
}

void main().catch((error) => {
  console.error("❌ Iseol doctor 실행에 실패했습니다.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
