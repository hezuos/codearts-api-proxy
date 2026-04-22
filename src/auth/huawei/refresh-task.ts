import {
  getSession,
  listSessionKeyIds,
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
    return false;
  }

  const now = Date.now();
  const remaining = expires - now;

  // 已过期 → 不刷新（需要重新登录）
  if (remaining <= 0) {
    return false;
  }

  // 剩余时间 < 2小时 → 刷新
  const jitter = Math.floor(Math.random() * 59000);
  return remaining - REFRESH_THRESHOLD_MS - jitter <= 0;
}

async function refreshOnce(): Promise<void> {
  if (running) {
    return;
  }

  running = true;
  try {
    let refreshed = 0;
    let expired = 0;
    const keyIds = listSessionKeyIds();
    for (const keyId of keyIds) {
      const session = getSession(keyId);
      if (!session) {
        continue;
      }

      // 检测已过期的 session
      if (session.expiresAt) {
        const expires = new Date(session.expiresAt).getTime();
        if (!Number.isNaN(expires) && expires <= Date.now()) {
          expired += 1;
          console.warn(
            `[refresh-task] Session for key ${keyId} has expired at ${session.expiresAt}. Please re-login to get new credentials.`,
          );
          continue;
        }
      }

      if (!shouldRefresh(session.expiresAt)) {
        continue;
      }

      try {
        await Promise.race([
          refreshStoredSession(keyId),
          new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error("refresh timeout")),
              REFRESH_TIMEOUT_MS,
            );
          }),
        ]);
        refreshed += 1;
      } catch (error) {
        console.warn(`Refresh task failed for key ${keyId}:`, error);
      }
    }

    if (refreshed > 0 || expired > 0) {
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
