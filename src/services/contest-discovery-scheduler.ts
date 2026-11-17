import { refreshActiveItContests, type Contest } from "./contests.js";

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 15 * 60 * 1000;

/** Milliseconds until the next 09:00 Asia/Seoul wall-clock time. */
export function millisecondsUntilNextKstNine(now = Date.now()): number {
  const seoulNow = new Date(now + SEOUL_OFFSET_MS);
  const targetKstAsUtc = Date.UTC(
    seoulNow.getUTCFullYear(),
    seoulNow.getUTCMonth(),
    seoulNow.getUTCDate(),
    9,
    0,
    0,
    0,
  );
  let nextRun = targetKstAsUtc - SEOUL_OFFSET_MS;
  if (nextRun <= now) nextRun += DAY_MS;
  return nextRun - now;
}

export function startDailyContestDiscoveryPolling(
  onSnapshot?: (contests: Contest[]) => Promise<unknown>,
  log: (message: string) => void = console.log,
): void {
  const schedule = (delay: number) => {
    const timer = setTimeout(() => { void refresh("scheduled"); }, delay);
    timer.unref?.();
  };

  const refresh = async (reason: "startup" | "scheduled") => {
    let contests: Contest[];
    try {
      contests = await refreshActiveItContests();
    } catch (error) {
      console.error(`공모전 일일 수집 실패 (${reason}); 15분 뒤 재시도`, error);
      schedule(RETRY_DELAY_MS);
      return;
    }

    log(`공모전 출처 수집 완료 (${reason === "startup" ? "시작 시" : "매일 09:00 KST"}): ${contests.length}개`);
    if (onSnapshot) {
      void onSnapshot(contests).catch((error) => {
        console.error("공모전 스냅샷 후속 처리 실패; 저장된 outbox 재시도로 복구합니다", error);
      });
    }
    schedule(millisecondsUntilNextKstNine());
  };

  void refresh("startup");
}
