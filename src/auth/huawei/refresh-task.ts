/**
 * 华为云凭证自动刷新任务。
 *
 * 使用 `RefreshScheduler` 为每个 **(Key, Account) 会话**独立调度，
 * 基于 expiresAt 精准计算下次刷新时间（过期前 2 小时 + 随机抖动）。
 *
 * 相比原 setInterval 方案：
 * - 每个会话独立调度，避免批量刷新风暴
 * - 精准基于过期时间，减少不必要的轮询
 * - 刷新成功后自动重新调度
 *
 * 调度粒度是 **(Key, Account)** 而非 Key：账号级 Key 可绑定多个账号，
 * 每个账号下的会话各自持有独立凭据，必须各自刷新。
 * 用户级 Key 不持有自有会话，因此不进入调度。
 */

import {
  getSession,
  listAllSessionEntries,
  logSessionCacheSummary,
  refreshStoredSession,
} from "./session-store";
import { RefreshScheduler } from "./refresh-scheduler";
import { isMasterNode } from "../../config";
import { logger } from "../../utils/logger";

const REFRESH_TIMEOUT_MS = 60 * 1000;

let started = false;
let enableRefreshTask = true;

/** 调度器按 (Key, Account) 组合索引。 */
const schedulers = new Map<string, RefreshScheduler>();

/** 组合键分隔符用 NUL，避免 Key/Account ID 自身含分隔符时产生歧义。 */
const SESSION_KEY_SEPARATOR = String.fromCharCode(0);

/** 调度器索引键：(Key, Account) 组合。 */
function schedulerKey(keyId: string, accountId: string): string {
  return keyId + SESSION_KEY_SEPARATOR + accountId;
}

/**
 * 刷新指定 (Key, Account) 会话并重新调度。
 */
async function refreshAndReschedule(
  keyId: string,
  accountId: string,
): Promise<void> {
  const session = getSession(keyId, accountId);
  if (!session) {
    logger.warn(
      `[refresh-task] Session not found for key ${keyId} account ${accountId}, removing scheduler`,
    );
    schedulers.delete(schedulerKey(keyId, accountId));
    return;
  }

  // 检测已过期的 session
  if (session.expiresAt) {
    const expires = new Date(session.expiresAt).getTime();
    if (!Number.isNaN(expires) && expires <= Date.now()) {
      logger.warn(
        `[refresh-task] Session for key ${keyId} account ${accountId} has expired at ${session.expiresAt}. Please re-login to get new credentials.`,
      );
      schedulers.delete(schedulerKey(keyId, accountId));
      return;
    }
  }

  try {
    let timeoutId: NodeJS.Timeout;
    await Promise.race([
      refreshStoredSession(keyId, accountId),
      new Promise<void>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("refresh timeout")),
          REFRESH_TIMEOUT_MS,
        );
      }),
    ]);
    clearTimeout(timeoutId!);

    // 刷新成功，重新调度
    const updatedSession = getSession(keyId, accountId);
    const scheduler = schedulers.get(schedulerKey(keyId, accountId));
    if (scheduler && updatedSession) {
      scheduler.schedule(updatedSession.expiresAt, () =>
        refreshAndReschedule(keyId, accountId),
      );
    }

    logSessionCacheSummary();
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[refresh-task] Refresh failed for key ${keyId} account ${accountId}`,
      {
        error: errorMsg,
      },
    );

    // 检测 refresh_token 是否永久失效（上游逻辑：ExpiredRefreshToken → 停止重试）
    // 对应错误: STS5.1806 / APIG.0602 + "refresh code has expired" / "kid not found" / "security token has expired"
    const isExpired =
      errorMsg.includes("refresh code has expired") ||
      errorMsg.includes("kid not found") ||
      errorMsg.includes("security token has expired") ||
      errorMsg.includes("Expired Refresh Token");

    if (isExpired) {
      logger.warn(
        `[refresh-task] Refresh token permanently expired for key ${keyId} account ${accountId}. Session will not be refreshed automatically. Please re-login.`,
      );
      schedulers.delete(schedulerKey(keyId, accountId));
      return;
    }

    // 非永久性失败：重新调度（使用原过期时间）
    const scheduler = schedulers.get(schedulerKey(keyId, accountId));
    if (scheduler) {
      scheduler.schedule(session.expiresAt, () =>
        refreshAndReschedule(keyId, accountId),
      );
    }
  }
}

/**
 * 为指定 (Key, Account) 会话启动调度。
 */
function scheduleSession(keyId: string, accountId: string): void {
  const session = getSession(keyId, accountId);
  if (!session) {
    return;
  }

  // 已过期的 session 不调度
  if (session.expiresAt) {
    const expires = new Date(session.expiresAt).getTime();
    if (!Number.isNaN(expires) && expires <= Date.now()) {
      logger.info(
        `[refresh-task] Skipping expired session for key ${keyId} account ${accountId}`,
      );
      return;
    }
  }

  const composite = schedulerKey(keyId, accountId);
  let scheduler = schedulers.get(composite);
  if (!scheduler) {
    scheduler = new RefreshScheduler();
    schedulers.set(composite, scheduler);
  }

  scheduler.schedule(session.expiresAt, () =>
    refreshAndReschedule(keyId, accountId),
  );
}

/**
 * 启动华为云凭证自动刷新任务。
 *
 * 遍历所有 (Key, Account) 会话，为每个会话启动独立调度。
 * 用户级 Key 没有自有会话，不会出现在遍历结果中，因此不进入调度。
 */
export function startHuaweiRefreshTask(): void {
  if (started || !enableRefreshTask || !isMasterNode) {
    return;
  }

  started = true;
  logger.info("[refresh-task] Starting dynamic refresh scheduler");

  // 遍历所有 (Key, Account) 会话并调度
  const entries = listAllSessionEntries();
  for (const { keyId, accountId } of entries) {
    scheduleSession(keyId, accountId);
  }

  logger.info(
    `[refresh-task] Scheduled ${schedulers.size} sessions for refresh`,
  );
}

/**
 * 停止华为云凭证自动刷新任务。
 *
 * 取消所有会话的调度。
 */
export function stopHuaweiRefreshTask(): void {
  for (const [composite, scheduler] of schedulers.entries()) {
    scheduler.cancel();
    logger.info(`[refresh-task] Cancelled scheduler for ${composite}`);
  }
  schedulers.clear();
  started = false;
  logger.info("[refresh-task] Stopped all refresh schedulers");
}

/**
 * 设置刷新任务启用状态。
 */
export function setRefreshTaskEnabled(value: boolean): void {
  enableRefreshTask = value;
}

/**
 * 为新登录的会话启动调度（供外部调用）。
 *
 * 账号级登录一次只产生一个账号下的会话，因此带上账号 ID 精确调度。
 */
export function scheduleSessionRefresh(
  keyId: string,
  accountId?: string,
): void {
  if (!started || !enableRefreshTask || !isMasterNode) {
    return;
  }
  if (accountId) {
    scheduleSession(keyId, accountId);
    return;
  }
  // 未指定账号：为该 Key 下的全部会话调度
  for (const entry of listAllSessionEntries()) {
    if (entry.keyId === keyId) {
      scheduleSession(entry.keyId, entry.accountId);
    }
  }
}

/**
 * 取消指定会话的调度（供外部调用，如解绑账号时）。
 *
 * 未指定账号时取消该 Key 下的全部调度。
 */
export function cancelSessionRefresh(
  keyId: string,
  accountId?: string,
): void {
  if (accountId) {
    const composite = schedulerKey(keyId, accountId);
    const scheduler = schedulers.get(composite);
    if (scheduler) {
      scheduler.cancel();
      schedulers.delete(composite);
    }
    return;
  }
  const prefix = keyId + SESSION_KEY_SEPARATOR;
  for (const [composite, scheduler] of schedulers.entries()) {
    if (composite.startsWith(prefix)) {
      scheduler.cancel();
      schedulers.delete(composite);
    }
  }
}

/**
 * 获取调度器状态（用于诊断）。
 */
export function getRefreshSchedulerStatus(): Array<{
  keyId: string;
  accountId: string;
  active: boolean;
  scheduledAt: number | null;
}> {
  return Array.from(schedulers.entries()).map(([composite, scheduler]) => {
    const separatorIndex = composite.indexOf(SESSION_KEY_SEPARATOR);
    return {
      keyId:
        separatorIndex >= 0 ? composite.slice(0, separatorIndex) : composite,
      accountId:
        separatorIndex >= 0
          ? composite.slice(separatorIndex + 1)
          : "(unknown)",
      ...scheduler.getStatus(),
    };
  });
}
