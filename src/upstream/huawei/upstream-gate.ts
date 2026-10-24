/**
 * 上游并发槽位控制。
 *
 * CodeArts v2 通道按华为账号统计「并发会话」，上限为 3；第 4 个在途请求
 * 会被直接拒绝（HTTP 400 / TM.00001041）。实测确认：
 * - 该计数是**账号级、在途**的，不区分对话内容；
 * - 官方客户端发送的 `x-session-affinity` 在该通道上不生效，
 *   它自身依靠「同一会话本地拒绝并发」把在途数压到 1；
 * - 同一账号下可能有其他消费方（官方 IDE、其他客户端、其他代理实例），
 *   代理只能看到自己的在途数，因此固定上限 3 仍会撞限。
 *
 * 本模块按 providerAccountId 维护 FIFO 队列，并在观察到 TM.00001041 时
 * 自动下调该账号的有效并发上限（最低 `UPSTREAM_MIN_CONCURRENCY`），
 * 在连续无撞限 `UPSTREAM_CONCURRENCY_RECOVER_MS` 后逐级恢复。
 */

import { config } from "../../config";
import { logger } from "../../utils/logger";

const CONCURRENT_SESSION_ERROR_CODE = "TM.00001041";
const CONCURRENT_SESSION_ERROR_TEXT = "并发会话数已达上限";

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  settled: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: NodeJS.Timeout;
}

interface AccountGate {
  active: number;
  waiters: Waiter[];
  /** 当前有效上限（自适应，≤ 配置上限） */
  limit: number;
  /** 最近一次撞限时间，用于恢复窗口判定 */
  lastLimitErrorAt?: number;
}

const gates = new Map<string, AccountGate>();

/** 测试注入：覆盖配置值，避免改全局 config 单例。 */
let limitOverride: number | undefined;
let waitTimeoutOverride: number | undefined;
let recoverMsOverride: number | undefined;

function resolveConfiguredLimit(): number {
  return limitOverride ?? config.upstreamMaxConcurrency;
}

function resolveMinLimit(): number {
  const configured = resolveConfiguredLimit();
  const min = config.upstreamMinConcurrency;
  if (!Number.isFinite(min) || min <= 0) return 1;
  return Math.min(min, configured);
}

function resolveWaitTimeout(): number {
  return waitTimeoutOverride ?? config.upstreamQueueWaitTimeoutMs;
}

function resolveRecoverMs(): number {
  return recoverMsOverride ?? config.upstreamConcurrencyRecoverMs;
}

function gateDisabled(): boolean {
  const limit = resolveConfiguredLimit();
  return !Number.isFinite(limit) || limit <= 0;
}

function getGate(accountId: string): AccountGate {
  let gate = gates.get(accountId);
  if (!gate) {
    gate = { active: 0, waiters: [], limit: Math.max(1, resolveConfiguredLimit()) };
    gates.set(accountId, gate);
  }
  return gate;
}

function detach(waiter: Waiter): void {
  if (waiter.timer) {
    clearTimeout(waiter.timer);
    waiter.timer = undefined;
  }
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.onAbort = undefined;
  }
}

function removeWaiter(gate: AccountGate, waiter: Waiter): void {
  const index = gate.waiters.indexOf(waiter);
  if (index >= 0) gate.waiters.splice(index, 1);
}

function makeRelease(accountId: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;

    const gate = gates.get(accountId);
    if (!gate) return;

    gate.active = Math.max(0, gate.active - 1);
    // 只按当前有效上限放行（上限可能已被撞限下调）。
    admitWaiters(accountId, gate);
    if (gate.active === 0 && gate.waiters.length === 0) {
      gates.delete(accountId);
    }
  };
}

/** 有效上限提高后，把排队者按 FIFO 放行。 */
function admitWaiters(accountId: string, gate: AccountGate): void {
  while (gate.waiters.length > 0 && gate.active < gate.limit) {
    const next = gate.waiters.shift()!;
    detach(next);
    next.settled = true;
    gate.active++;
    next.resolve(makeRelease(accountId));
  }
}

/**
 * 获取一个上游并发槽位。返回的函数必须且只需调用一次。
 *
 * 队列等待期间支持 AbortSignal：客户端断开时立即放弃排队。
 */
export function acquireUpstreamSlot(
  accountId: string,
  signal?: AbortSignal,
): Promise<() => void> {
  if (gateDisabled()) {
    return Promise.resolve(() => {
      /* gate disabled */
    });
  }

  if (signal?.aborted) {
    return Promise.reject(new Error("Request aborted before acquiring upstream slot"));
  }

  const gate = getGate(accountId);
  if (gate.active < gate.limit && gate.waiters.length === 0) {
    gate.active++;
    return Promise.resolve(makeRelease(accountId));
  }

  logQueueWait(accountId, gate, signal);

  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = { resolve, reject, settled: false, signal };

    if (signal) {
      waiter.onAbort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        detach(waiter);
        removeWaiter(gate, waiter);
        if (gate.active === 0 && gate.waiters.length === 0) gates.delete(accountId);
        reject(new Error("Request aborted while waiting for upstream slot"));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }

    const waitTimeout = resolveWaitTimeout();
    if (Number.isFinite(waitTimeout) && waitTimeout > 0) {
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        detach(waiter);
        removeWaiter(gate, waiter);
        if (gate.active === 0 && gate.waiters.length === 0) gates.delete(accountId);
        reject(
          new Error(
            `Timed out after ${waitTimeout}ms waiting for an upstream slot ` +
              `(all ${gate.limit} slots busy for this account)`,
          ),
        );
      }, waitTimeout);
      waiter.timer.unref();
    }

    gate.waiters.push(waiter);
  });
}

function logQueueWait(accountId: string, gate: AccountGate, signal?: AbortSignal): void {
  logger.info("[proxy→codearts] upstream concurrency limit reached, queueing request", {
    provider_account: accountId,
    active: gate.active,
    queued: gate.waiters.length + 1,
    effective_limit: gate.limit,
    configured_limit: resolveConfiguredLimit(),
    aborted: !!signal?.aborted,
  });
}

/**
 * 上报一次 TM.00001041：说明该账号的真实可用并发低于本地有效上限
 * （其他客户端占用了共享槽位），因此下调一档。
 */
export function reportConcurrencyLimit(accountId: string): number {
  if (gateDisabled()) return 0;
  const gate = getGate(accountId);
  const previous = gate.limit;
  gate.limit = Math.max(resolveMinLimit(), gate.limit - 1);
  gate.lastLimitErrorAt = Date.now();
  if (gate.limit !== previous) {
    logger.warn("[proxy→codearts] downgrading upstream concurrency limit", {
      provider_account: accountId,
      previous_limit: previous,
      effective_limit: gate.limit,
    });
  }
  return gate.limit;
}

/**
 * 上报一次上游成功。若已连续 `UPSTREAM_CONCURRENCY_RECOVER_MS` 无撞限，
 * 则逐级恢复有效上限（每次 +1）。
 */
export function reportUpstreamSuccess(accountId: string): void {
  if (gateDisabled()) return;
  const gate = gates.get(accountId);
  if (!gate) return;

  const configured = resolveConfiguredLimit();
  if (gate.limit >= configured) return;

  const since = Date.now() - (gate.lastLimitErrorAt ?? 0);
  if (since < resolveRecoverMs()) return;

  gate.limit = Math.min(configured, gate.limit + 1);
  logger.info("[proxy→codearts] restoring upstream concurrency limit", {
    provider_account: accountId,
    effective_limit: gate.limit,
    configured_limit: configured,
  });
  admitWaiters(accountId, gate);
}

/** 当前账号的槽位使用情况（日志/测试用）。 */
export function getUpstreamGateStats(accountId: string): {
  active: number;
  queued: number;
  limit: number;
} {
  const gate = gates.get(accountId);
  return {
    active: gate?.active ?? 0,
    queued: gate?.waiters.length ?? 0,
    limit: gate?.limit ?? Math.max(1, resolveConfiguredLimit()),
  };
}

/**
 * 判断上游错误是否属于「并发会话数已达上限」。
 * 同时覆盖 HTTP 400 body（v2 通道）与 SSE error_code。
 */
export function isConcurrentSessionLimitError(text: string | undefined): boolean {
  if (!text) return false;
  return (
    text.includes(CONCURRENT_SESSION_ERROR_CODE) ||
    text.includes(CONCURRENT_SESSION_ERROR_TEXT)
  );
}

export const __testHooks = {
  reset(): void {
    gates.clear();
    limitOverride = undefined;
    waitTimeoutOverride = undefined;
    recoverMsOverride = undefined;
  },
  setLimit(limit: number | undefined): void {
    limitOverride = limit;
  },
  setWaitTimeout(timeoutMs: number | undefined): void {
    waitTimeoutOverride = timeoutMs;
  },
  setRecoverMs(ms: number | undefined): void {
    recoverMsOverride = ms;
  },
  stats: getUpstreamGateStats,
};
