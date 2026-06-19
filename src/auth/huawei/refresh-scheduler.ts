/**
 * 动态凭证刷新调度器（v5.0.2 新增）。
 *
 * 对标上游 `RefreshScheduler`，使用 setTimeout 动态调度，
 * 根据凭证过期时间计算下次刷新点（过期前 2 小时 + 随机抖动）。
 *
 * 相比原有 setInterval 固定间隔方案：
 * - 精准：基于 expiresAt 计算，避免不必要的轮询
 * - 分散：随机抖动避免多 session 同时刷新
 * - 自愈：每次刷新后重新调度
 */

import { logger } from "../../utils/logger";

const MAX_JITTER_MS = 59 * 1000; // 59 秒
const MIN_REFRESH_DELAY_MS = 5 * 60 * 1000; // 最小 5 分钟

export class RefreshScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshFn: (() => Promise<void>) | null = null;
  private scheduledAt: number | null = null;

  /**
   * 计算下次刷新延迟（毫秒）。
   *
   * 算法：在剩余时间的中间点刷新，确保：
   * - 不会频繁刷新（避免限流）
   * - 有足够的时间余量
   * - 抖动分散多 session 的刷新时间
   *
   * 例子（token 寿命 2h）：
   *   初始:  剩余 120min → 在 60min 后刷新
   *   刷新后: 新 token 也剩 120min → 在 60min 后刷新
   *
   * 如果 token 已过期，仍返回 MIN_REFRESH_DELAY_MS（5分钟），
   * 让 scheduler 继续重试，而不是永久放弃。
   *
   * @returns 延迟毫秒数，始终 >= MIN_REFRESH_DELAY_MS
   */
  calculateNextDelay(expiresAt?: string): number {
    if (!expiresAt) {
      return MIN_REFRESH_DELAY_MS;
    }

    const expires = new Date(expiresAt).getTime();
    if (Number.isNaN(expires)) {
      return MIN_REFRESH_DELAY_MS;
    }

    const now = Date.now();
    const timeToExpiry = expires - now;

    // 已过期 → 不调度
    if (timeToExpiry <= 0) {
      return -1;
    }

    // 在剩余时间的中间点刷新 + 随机抖动
    const delay = Math.floor(timeToExpiry / 2);
    const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
    return Math.max(MIN_REFRESH_DELAY_MS, delay + jitter);
  }

  /**
   * 调度下次刷新。
   *
   * @param expiresAt - 凭证过期时间（ISO 字符串）
   * @param refreshFn - 刷新回调函数
   */
  schedule(expiresAt: string | undefined, refreshFn: () => Promise<void>): void {
    // 取消现有调度
    this.cancel();

    this.refreshFn = refreshFn;
    const delay = this.calculateNextDelay(expiresAt);

    // -1 表示 token 已过期，不需要调度
    if (delay < 0) {
      logger.info(
        `[refresh-scheduler] token expired at ${expiresAt}, skipping refresh schedule`,
      );
      return;
    }

    this.scheduledAt = Date.now() + delay;

    logger.info(
      `[refresh-scheduler] scheduling next refresh in ${Math.round(delay / 1000)}s (expiresAt=${expiresAt ?? "unknown"})`,
    );

    this.timer = setTimeout(async () => {
      logger.info("[refresh-scheduler] refresh timer fired");
      try {
        if (this.refreshFn) {
          await this.refreshFn();
        }
      } catch (error) {
        logger.error("[refresh-scheduler] refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, delay);
  }

  /**
   * 取消当前调度。
   */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduledAt = null;
  }

  /**
   * 获取调度状态（用于诊断）。
   */
  getStatus(): { active: boolean; scheduledAt: number | null } {
    return {
      active: this.timer !== null,
      scheduledAt: this.scheduledAt,
    };
  }
}
