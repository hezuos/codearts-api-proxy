/**
 * 华为云凭证自动刷新任务（v5.0.2 重构）。
 *
 * 使用 `RefreshScheduler` 为每个 session 独立调度，
 * 基于 expiresAt 精准计算下次刷新时间（过期前 2 小时 + 随机抖动）。
 *
 * 相比原 setInterval 方案：
 * - 每个 session 独立调度，避免批量刷新风暴
 * - 精准基于过期时间，减少不必要的轮询
 * - 刷新成功后自动重新调度
 */

import {
  getSession,
  listSessionKeyIds,
  logSessionCacheSummary,
  refreshStoredSession,
} from "./session-store";
import { RefreshScheduler } from "./refresh-scheduler";
import { isMasterNode } from "../../config";
import { logger } from "../../utils/logger";

const REFRESH_TIMEOUT_MS = 15 * 1000;

let started = false;
let enableRefreshTask = true;
const schedulers = new Map<string, RefreshScheduler>();

/**
 * 刷新指定 session 并重新调度。
 */
async function refreshAndReschedule(keyId: string): Promise<void> {
  const session = getSession(keyId);
  if (!session) {
    logger.warn(`[refresh-task] Session not found for key ${keyId}, removing scheduler`);
    schedulers.delete(keyId);
    return;
  }

  // 检测已过期的 session
  if (session.expiresAt) {
    const expires = new Date(session.expiresAt).getTime();
    if (!Number.isNaN(expires) && expires <= Date.now()) {
      logger.warn(
        `[refresh-task] Session for key ${keyId} has expired at ${session.expiresAt}. Please re-login to get new credentials.`,
      );
      schedulers.delete(keyId);
      return;
    }
  }

  try {
    let timeoutId: NodeJS.Timeout;
    await Promise.race([
      refreshStoredSession(keyId),
      new Promise<void>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("refresh timeout")),
          REFRESH_TIMEOUT_MS,
        );
      }),
    ]);
    clearTimeout(timeoutId!);

    // 刷新成功，重新调度
    const updatedSession = getSession(keyId);
    const scheduler = schedulers.get(keyId);
    if (scheduler && updatedSession) {
      scheduler.schedule(updatedSession.expiresAt, () => refreshAndReschedule(keyId));
    }

    logSessionCacheSummary();
  } catch (error) {
    logger.warn(`[refresh-task] Refresh failed for key ${keyId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    // 刷新失败也重新调度（使用原过期时间）
    const scheduler = schedulers.get(keyId);
    if (scheduler) {
      scheduler.schedule(session.expiresAt, () => refreshAndReschedule(keyId));
    }
  }
}

/**
 * 为指定 session 启动调度。
 */
function scheduleSession(keyId: string): void {
  const session = getSession(keyId);
  if (!session) {
    return;
  }

  // 已过期的 session 不调度
  if (session.expiresAt) {
    const expires = new Date(session.expiresAt).getTime();
    if (!Number.isNaN(expires) && expires <= Date.now()) {
      logger.info(`[refresh-task] Skipping expired session for key ${keyId}`);
      return;
    }
  }

  let scheduler = schedulers.get(keyId);
  if (!scheduler) {
    scheduler = new RefreshScheduler();
    schedulers.set(keyId, scheduler);
  }

  scheduler.schedule(session.expiresAt, () => refreshAndReschedule(keyId));
}

/**
 * 启动华为云凭证自动刷新任务。
 *
 * 遍历所有已有 session，为每个 session 启动独立调度。
 */
export function startHuaweiRefreshTask(): void {
  if (started || !enableRefreshTask || !isMasterNode) {
    return;
  }

  started = true;
  logger.info("[refresh-task] Starting dynamic refresh scheduler");

  // 遍历所有 session 并调度
  const keyIds = listSessionKeyIds();
  for (const keyId of keyIds) {
    scheduleSession(keyId);
  }

  logger.info(`[refresh-task] Scheduled ${schedulers.size} sessions for refresh`);
}

/**
 * 停止华为云凭证自动刷新任务。
 *
 * 取消所有 session 的调度。
 */
export function stopHuaweiRefreshTask(): void {
  for (const [keyId, scheduler] of schedulers.entries()) {
    scheduler.cancel();
    logger.info(`[refresh-task] Cancelled scheduler for key ${keyId}`);
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
 * 为新登录的 session 启动调度（供外部调用）。
 */
export function scheduleSessionRefresh(keyId: string): void {
  if (!started || !enableRefreshTask || !isMasterNode) {
    return;
  }
  scheduleSession(keyId);
}

/**
 * 取消指定 session 的调度（供外部调用，如解绑账号时）。
 */
export function cancelSessionRefresh(keyId: string): void {
  const scheduler = schedulers.get(keyId);
  if (scheduler) {
    scheduler.cancel();
    schedulers.delete(keyId);
  }
}

/**
 * 获取调度器状态（用于诊断）。
 */
export function getRefreshSchedulerStatus(): Array<{ keyId: string; active: boolean; scheduledAt: number | null }> {
  return Array.from(schedulers.entries()).map(([keyId, scheduler]) => ({
    keyId,
    ...scheduler.getStatus(),
  }));
}
