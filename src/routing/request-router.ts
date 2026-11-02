/**
 * 请求路由：账号选择与跨账号失败迁移。
 *
 * 选择器决定"先试谁"，本模块决定"失败后换谁"，二者共同构成一次请求的
 * 账号级容错。跨账号迁移发生在上游层**同账号重试耗尽之后**——上游层的
 * 同账号退避重试策略保持不变。
 */

import type { AuthContext, AccountAuthContext } from "../store/api-key-store";
import { getApiKey } from "../store/hierarchical-store";
import type { StoredHuaweiSession } from "../auth/huawei/session-store";
import {
  UpstreamAuthError,
  UpstreamConcurrencyError,
  UpstreamContextLengthError,
  UpstreamServerError,
} from "../utils/errors";
import {
  selectAccount,
  setStickyAccount,
  type CandidateAccount,
  type RoutingPolicy,
  type SelectionReason,
} from "./account-selector";
import {
  listBoundUsableAccounts,
  listUsableAccounts,
  type UsableAccount,
} from "./candidate-pool";

/** 迁移原因——决定该账号的冷却类型与时长。 */
export type MigrationCause = "concurrency" | "credential" | "model";

/** 本次请求实际使用的账号与会话。 */
export interface RouteTarget {
  accountId: string;
  keyId: string;
  session: StoredHuaweiSession;
}

export interface RoutePlan {
  target: RouteTarget;
  /** 选择依据。 */
  reason: SelectionReason;
  /** 是否需要记录对话粘性绑定。 */
  bindConversation: boolean;
  /** 本次使用的路由策略。 */
  policy: RoutingPolicy;
}

/**
 * 该 Key 的路由策略。
 *
 * 账号级 Key 粘性优先、容量次之，不主动轮询；
 * 用户级 Key 按其分配粒度（对话连续 / 按请求）执行。
 */
export function resolveRoutingPolicy(auth: AuthContext): RoutingPolicy {
  if (auth.kind === "account") return "sticky";
  return auth.balancingPolicy;
}

/** 账号级鉴权上下文对应的候选账号。 */
function listCandidatesForAccountAuth(
  auth: AccountAuthContext,
): UsableAccount[] {
  const key = getApiKey(auth.apiKeyId);
  if (!key) return [];
  return listBoundUsableAccounts(key);
}

/**
 * 规划一次请求的路由。
 *
 * @param excludeAccountIds 本次请求已尝试过的账号——每个账号在一次请求内
 *   至多尝试一次，因此已尝试过的账号不再进入候选集。
 */
export function planRoute(input: {
  auth: AuthContext;
  conversationId?: string;
  excludeAccountIds?: Set<string>;
}): RoutePlan | null {
  const { auth, conversationId } = input;
  const exclude = input.excludeAccountIds ?? new Set<string>();
  const policy = resolveRoutingPolicy(auth);

  const usable =
    auth.kind === "account"
      ? listCandidatesForAccountAuth(auth)
      : listUsableAccounts(auth.userId);

  const candidates: CandidateAccount[] = usable
    .filter((u) => !exclude.has(u.accountId))
    .map((u) => ({
      accountId: u.accountId,
      keyId: u.keyId,
      hasFreeSlot: u.hasFreeSlot,
    }));

  if (candidates.length === 0) return null;

  const selected = selectAccount({
    keyId: auth.apiKeyId,
    policy,
    conversationId,
    candidates,
  });
  if (!selected) return null;

  const chosen = usable.find((u) => u.accountId === selected.accountId);
  if (!chosen) return null;

  const plan: RoutePlan = {
    target: {
      accountId: chosen.accountId,
      keyId: chosen.keyId,
      session: chosen.session,
    },
    reason: selected.reason,
    bindConversation: selected.bindConversation,
    policy,
  };

  // 新分配的对话在此登记粘性绑定——"这个对话跑在这个账号上"是路由决定的
  // 一部分，与调用方是否真正发起请求无关。
  commitConversationBinding(plan, auth.apiKeyId, conversationId);

  return plan;
}

/**
 * 记录对话粘性绑定——仅在"新分配"时写入。
 */
export function commitConversationBinding(
  plan: RoutePlan,
  keyId: string,
  conversationId: string | undefined,
): void {
  if (!plan.bindConversation || !conversationId) return;
  setStickyAccount(keyId, conversationId, plan.target.accountId);
}

/** 提取上游响应体（用于错误语义判定）。 */
function extractResponseBody(error: unknown): string {
  if (
    error instanceof UpstreamAuthError ||
    error instanceof UpstreamServerError ||
    error instanceof UpstreamContextLengthError
  ) {
    return error.responseBody;
  }
  return "";
}

/**
 * 上游"模型不可用"。
 *
 * 不同华为账号可见的模型不同（配额、灰度、区域差异），因此模型不可用
 * 是**账号相关**失败——换一个账号可能成功。
 */
export function isModelUnavailableError(error: unknown): boolean {
  const parts: string[] = [];
  if (error instanceof Error) parts.push(error.message);
  const body = extractResponseBody(error);
  if (body) parts.push(body);
  const text = parts.join("\n");
  if (!text) return false;
  return (
    /model[^\n]{0,80}?\b(not\s+(found|available|supported)|unsupported)\b/i.test(
      text,
    ) || /\bmodel_not_found\b/i.test(text)
  );
}

/**
 * 判断错误是否可通过换账号恢复。
 *
 * - 并发受限：换账号即可；
 * - 凭证失效：换账号即可；
 * - 模型不可用：换账号可能可见该模型。
 *
 * 其余错误（上下文超限、网络错误、5xx）不迁移——换账号同样会失败。
 */
export function classifyMigrationCause(
  error: unknown,
): MigrationCause | null {
  if (error instanceof UpstreamConcurrencyError) return "concurrency";
  if (error instanceof UpstreamAuthError) return "credential";
  if (isModelUnavailableError(error)) return "model";
  return null;
}
