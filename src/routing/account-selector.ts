/**
 * 账号选择器：粘性映射、轮询游标、冷却状态与候选排序。
 *
 * 选择器只负责"往哪发"；"能不能发"由上游并发闸门负责。两者通过闸门既有的
 * 只读统计接口衔接——选择器读槽位占用情况来排序候选，但**不占用**槽位。
 *
 * 所有状态均为**进程内**：重启后粘性绑定与轮询游标归零。对话粘性保证以
 * 单个代理实例为边界（多实例部署下各实例独立分配）。
 */

import { config } from "../config";
import { logger } from "../utils/logger";
import { getUpstreamGateStats } from "../upstream/huawei/upstream-gate";
import type { BalancingPolicy } from "../db/models/api-key";

/**
 * 路由策略。
 *
 * - `sticky`：账号级 Key——粘性优先、容量次之，**不主动轮询**；
 * - `conversation`：用户级 Key 的对话连续粒度；
 * - `request`：用户级 Key 的按请求粒度。
 */
export type RoutingPolicy = "sticky" | BalancingPolicy;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 冷却原因。 */
export type CooldownReason = "concurrency" | "credential" | "model";

/** 选择依据，用于可观测性。 */
export type SelectionReason =
  /** 命中该对话此前的粘性绑定。 */
  | "sticky-hit"
  /** 无粘性绑定（或绑定已失效），按轮询顺序分配。 */
  | "round-robin";

/** 候选账号：调用方按"可用"三条件合取求值后给出。 */
export interface CandidateAccount {
  accountId: string;
  /** 该账号下用于借用会话的账号级 Key ID。 */
  keyId: string;
  /** 该账号当前是否有空闲并发槽位。 */
  hasFreeSlot: boolean;
}

export interface SelectionInput {
  /** 发起请求的 Key（账号级或用户级）。 */
  keyId: string;
  /** 路由策略。 */
  policy: RoutingPolicy;
  /** 对话标识；不可得时为 undefined。 */
  conversationId?: string;
  /** 候选账号（已按可用条件过滤）。 */
  candidates: CandidateAccount[];
}

export interface SelectionResult {
  accountId: string;
  keyId: string;
  reason: SelectionReason;
  /** 是否需要记录对话粘性绑定（对话粒度下的新分配）。 */
  bindConversation: boolean;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

interface CooldownEntry {
  until: number;
  reason: CooldownReason;
}

interface StickyBinding {
  accountId: string;
  updatedAt: number;
}

/** 账号冷却：accountId → 冷却条目。 */
const cooldowns = new Map<string, CooldownEntry>();

/** 对话粘性：keyId → conversationId → 绑定。 */
const stickyBindings = new Map<string, Map<string, StickyBinding>>();

/** 轮询游标：keyId → 单调递增整数。 */
const roundRobinCursors = new Map<string, number>();

// ---------------------------------------------------------------------------
// 3.1 槽位可用性（只读，不占槽）
// ---------------------------------------------------------------------------

/**
 * 账号当前是否有空闲并发槽位。
 *
 * 复用闸门既有的只读统计接口：探测 SHALL NOT 获取或预留槽位。
 *
 * 判定口径与闸门的放行条件一致——有等待者时说明槽位已被排队请求预占，
 * 此时新请求入闸只会排在队尾，因此不算"有空闲槽位"。
 */
export function hasFreeSlot(accountId: string): boolean {
  const stats = getUpstreamGateStats(accountId);
  return stats.active < stats.limit && stats.queued === 0;
}

// ---------------------------------------------------------------------------
// 3.3 冷却状态
// ---------------------------------------------------------------------------

function cooldownDurationMs(reason: CooldownReason): number {
  switch (reason) {
    case "credential":
      return config.routingCooldownCredentialMs;
    case "model":
      return config.routingCooldownModelMs;
    case "concurrency":
    default:
      return config.routingCooldownConcurrencyMs;
  }
}

/**
 * 标记账号冷却。
 *
 * 冷却 SHALL 把账号整个移出候选集，而不仅是降低其并发上限——
 * 闸门的自适应降级只影响"该账号还能并发几个"，不阻止选择器选中它。
 */
export function markAccountCoolingDown(
  accountId: string,
  reason: CooldownReason,
): void {
  const duration = cooldownDurationMs(reason);
  const until = Date.now() + duration;
  cooldowns.set(accountId, { until, reason });
  logger.info("[routing] account entered cooldown", {
    provider_account: accountId,
    reason,
    duration_ms: duration,
  });
}

/** 清除账号冷却。 */
export function clearAccountCooldown(accountId: string): void {
  cooldowns.delete(accountId);
}

/** 账号当前是否处于冷却期。 */
export function isAccountCoolingDown(accountId: string): boolean {
  const entry = cooldowns.get(accountId);
  if (!entry) return false;
  if (Date.now() >= entry.until) {
    cooldowns.delete(accountId);
    return false;
  }
  return true;
}

/** 账号冷却剩余毫秒数；未冷却时为 0。 */
export function getCooldownRemainingMs(accountId: string): number {
  const entry = cooldowns.get(accountId);
  if (!entry) return 0;
  return Math.max(0, entry.until - Date.now());
}

// ---------------------------------------------------------------------------
// 3.2 对话粘性绑定
// ---------------------------------------------------------------------------

/** 取该对话此前绑定的账号；空闲超时或不存在时返回 undefined。 */
export function getStickyAccount(
  keyId: string,
  conversationId: string,
): string | undefined {
  const table = stickyBindings.get(keyId);
  if (!table) return undefined;
  const binding = table.get(conversationId);
  if (!binding) return undefined;
  if (Date.now() - binding.updatedAt > config.routingStickyIdleMs) {
    table.delete(conversationId);
    return undefined;
  }
  return binding.accountId;
}

/** 记录该对话的账号绑定，并按容量上限淘汰旧条目。 */
export function setStickyAccount(
  keyId: string,
  conversationId: string,
  accountId: string,
): void {
  let table = stickyBindings.get(keyId);
  if (!table) {
    table = new Map<string, StickyBinding>();
    stickyBindings.set(keyId, table);
  }
  table.set(conversationId, { accountId, updatedAt: Date.now() });
  evictOverflow(table);
}

/** 绑定表超出容量上限时淘汰最旧的条目。 */
function evictOverflow(table: Map<string, StickyBinding>): void {
  const max = config.routingStickyMaxEntries;
  while (table.size > max) {
    let oldestKey: string | undefined;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [key, binding] of table.entries()) {
      if (binding.updatedAt < oldestTs) {
        oldestTs = binding.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    table.delete(oldestKey);
  }
}

// ---------------------------------------------------------------------------
// 轮询游标
// ---------------------------------------------------------------------------

/**
 * 推进轮询游标并返回本次的起始下标。
 *
 * 游标是单调递增整数，对候选集取模得到目标账号；候选集增删只改变取模结果，
 * 不影响游标本身的连续性。
 */
export function nextRoundRobinIndex(
  keyId: string,
  candidateCount: number,
): number {
  if (candidateCount <= 0) return 0;
  const cursor = roundRobinCursors.get(keyId) ?? 0;
  roundRobinCursors.set(keyId, cursor + 1);
  return cursor % candidateCount;
}

/** 当前轮询游标值（诊断用）。 */
export function getRoundRobinCursor(keyId: string): number {
  return roundRobinCursors.get(keyId) ?? 0;
}

// ---------------------------------------------------------------------------
// 选择
// ---------------------------------------------------------------------------

/**
 * 按轮询起点旋转候选，再把有空闲槽位的账号排在前面。
 */
function orderByCapacity(
  pool: CandidateAccount[],
  start: number,
): CandidateAccount[] {
  const rotated =
    start <= 0 ? [...pool] : [...pool.slice(start), ...pool.slice(0, start)];
  const withSlot = rotated.filter((c) => c.hasFreeSlot);
  const withoutSlot = rotated.filter((c) => !c.hasFreeSlot);
  return [...withSlot, ...withoutSlot];
}

/**
 * 选择本次请求使用的账号。
 *
 * 选择顺序：**粘性优先、容量次之**。
 * - 对话粒度：命中该对话此前的绑定则复用；绑定账号不可用时重新分配并改绑；
 * - 请求粒度：每个请求都按轮询顺序重新分配，不保持绑定。
 */
export function selectAccount(input: SelectionInput): SelectionResult | null {
  const { keyId, policy, conversationId, candidates } = input;
  if (candidates.length === 0) return null;

  // 冷却中的账号退出候选集；全部冷却时退回全量候选，由闸门排队兜底。
  const available = candidates.filter((c) => !isAccountCoolingDown(c.accountId));
  const pool = available.length > 0 ? available : candidates;

  let reason: SelectionReason = "round-robin";
  let bindConversation = false;

  // 粘性优先：复用该对话此前的账号。
  if (policy === "conversation" || policy === "sticky") {
    if (conversationId) {
      const stickyAccountId = getStickyAccount(keyId, conversationId);
      if (stickyAccountId) {
        const sticky = pool.find((c) => c.accountId === stickyAccountId);
        if (sticky && sticky.hasFreeSlot) {
          reason = "sticky-hit";
          logSelection(input, sticky, reason, pool.length);
          return {
            accountId: sticky.accountId,
            keyId: sticky.keyId,
            reason,
            bindConversation: false,
          };
        }
      }
    }
    // 对话粒度下无绑定、或绑定账号已不可用 → 新分配并改绑。
    // 账号级 Key（sticky）不因临时饱和而丢失绑定——账号恢复后仍应复用。
    bindConversation = policy === "conversation";
  }

  // 账号级 Key 不主动轮询：按容量顺序取，不推进游标。
  const start =
    policy === "sticky" ? 0 : nextRoundRobinIndex(keyId, pool.length);
  const ordered = orderByCapacity(pool, start);
  const chosen = ordered[0];
  if (!chosen) return null;

  logSelection(input, chosen, reason, pool.length);
  return {
    accountId: chosen.accountId,
    keyId: chosen.keyId,
    reason,
    bindConversation,
  };
}

/**
 * 3.4 选择结果写入结构化日志。
 *
 * 日志含对话标识、选中账号、选择依据与分配粒度——重启后首次选择依据为
 * "round-robin"（无绑定），可据此把重启误读为策略异常的情况区分开。
 */
function logSelection(
  input: SelectionInput,
  chosen: CandidateAccount,
  reason: SelectionReason,
  poolSize: number,
): void {
  logger.info("[routing] account selected", {
    key_id: input.keyId,
    conversation_id: input.conversationId ?? "(none)",
    provider_account: chosen.accountId,
    reason,
    granularity: input.policy,
    candidate_count: input.candidates.length,
    eligible_count: poolSize,
    has_free_slot: chosen.hasFreeSlot,
  });
}

// ---------------------------------------------------------------------------
// 诊断与测试钩子
// ---------------------------------------------------------------------------

/** 各账号的冷却剩余时间（毫秒），供管理界面展示。 */
export function listAccountCooldowns(): Array<{
  accountId: string;
  reason: CooldownReason;
  remainingMs: number;
}> {
  const now = Date.now();
  const result: Array<{
    accountId: string;
    reason: CooldownReason;
    remainingMs: number;
  }> = [];
  for (const [accountId, entry] of cooldowns.entries()) {
    if (entry.until <= now) {
      cooldowns.delete(accountId);
      continue;
    }
    result.push({
      accountId,
      reason: entry.reason,
      remainingMs: entry.until - now,
    });
  }
  return result;
}

/** 对话粘性绑定表条目数（诊断用）。 */
export function countStickyBindings(): number {
  let total = 0;
  for (const table of stickyBindings.values()) {
    total += table.size;
  }
  return total;
}

export const __testHooks = {
  reset(): void {
    cooldowns.clear();
    stickyBindings.clear();
    roundRobinCursors.clear();
  },
};
