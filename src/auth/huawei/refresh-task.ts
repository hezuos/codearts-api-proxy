import {
  getSession,
  listSessionProviderAccountIds,
  logSessionCacheSummary,
  refreshStoredSession,
} from "./session-store";

const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const REFRESH_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15 * 1000;

let started = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let enableRefreshTask = true;
let isMasterNode = true;

function shouldRefresh(expiresAt?: string): boolean {
  if (!expiresAt) {
    return false;
  }

  const expires = new Date(expiresAt).getTime();
  if (Number.isNaN(expires)) {
    return true;
  }

  const jitter = Math.floor(Math.random() * 59000);
  return expires - Date.now() - REFRESH_THRESHOLD_MS - jitter <= 0;
}

async function refreshOnce(): Promise<void> {
  if (running) {
    return;
  }

  running = true;
  try {
    let refreshed = 0;
    const providerAccountIds = listSessionProviderAccountIds();
    for (const providerAccountId of providerAccountIds) {
      const session = getSession(providerAccountId);
      if (!session || !shouldRefresh(session.expiresAt)) {
        continue;
      }

      try {
        await Promise.race([
          refreshStoredSession(providerAccountId),
          new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error("refresh timeout")),
              REFRESH_TIMEOUT_MS,
            );
          }),
        ]);
        refreshed += 1;
      } catch (error) {
        console.warn(`Refresh task failed for ${providerAccountId}:`, error);
      }
    }

    if (refreshed > 0) {
      logSessionCacheSummary();
    }
  } finally {
    running = false;
  }
}

export function startHuaweiRefreshTask(): void {
  if (started || !enableRefreshTask || !isMasterNode) {
    return;
  }

  started = true;
  void refreshOnce();
  timer = setInterval(() => {
    void refreshOnce();
  }, REFRESH_INTERVAL_MS);
}

export function stopHuaweiRefreshTask(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}

export function setRefreshTaskEnabled(value: boolean): void {
  enableRefreshTask = value;
}

export function setMasterNode(value: boolean): void {
  isMasterNode = value;
}
