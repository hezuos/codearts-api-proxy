/**
 * 跨账号迁移循环。
 *
 * 与 HTTP 框架解耦：路由层只需提供"执行一次上游请求"的回调与最终错误回调，
 * 迁移策略（选谁、换谁、何时放弃）全部集中在此，便于单测。
 *
 * 规则：
 * - 每个账号在一次请求内**至多尝试一次**；
 * - 跨账号迁移发生在上游层**同账号重试耗尽之后**；
 * - 凭证失效先刷新重试同一账号，刷新后仍失败才换账号；
 * - 换下的账号进入冷却，后续请求不再选它。
 */

import type { AuthContext } from "../store/api-key-store";
import { NoUsableAccountError, UpstreamAuthError } from "../utils/errors";
import { markAccountCoolingDown } from "./account-selector";
import {
  classifyMigrationCause,
  planRoute,
  type MigrationCause,
  type RouteTarget,
} from "./request-router";

export interface MigrationLoopInput {
  /** 鉴权上下文（账号级或用户级）。 */
  auth: AuthContext;
  /** 对话标识；不可得时为 undefined。 */
  conversationId?: string;
  /** 客户端断开时中止上游请求。 */
  signal: AbortSignal;
  /** 执行一次上游请求；失败时抛错。 */
  attempt: (target: RouteTarget, signal: AbortSignal) => Promise<void>;
  /** 刷新被选中账号的凭证；缺省表示不支持刷新。 */
  refresh?: (target: RouteTarget) => Promise<RouteTarget["session"] | undefined>;
  /** 响应是否已开始下发——已开始则无法换账号重来。 */
  responseStarted: () => boolean;
  /** 最终失败回调。 */
  onFinalError: (error: unknown) => void;
  /** 迁移事件回调（用于日志）。 */
  onMigrate?: (info: {
    fromAccountId: string;
    cause: MigrationCause;
    attempted: number;
  }) => void;
  /** 凭证刷新触发回调。 */
  onAuthRefresh?: (target: RouteTarget, httpStatus: number) => void;
  /** 刷新后重试仍失败的回调。 */
  onRefreshRetryFailed?: (error: unknown) => void;
}

/**
 * 执行一次请求，必要时跨账号迁移。
 */
export async function runMigrationLoop(
  input: MigrationLoopInput,
): Promise<void> {
  const { auth, conversationId, signal } = input;
  const attempted = new Set<string>();
  let lastError: unknown;

  for (;;) {
    const plan = planRoute({
      auth,
      conversationId,
      excludeAccountIds: attempted,
    });
    if (!plan) break;

    attempted.add(plan.target.accountId);

    try {
      await input.attempt(plan.target, signal);
      return;
    } catch (caught) {
      // ESLint 禁止给异常参数重新赋值——用局部变量承接刷新后的新错误。
      let error: unknown = caught;
      // 响应已开始下发 → 无法换账号重来，直接上报错误。
      if (input.responseStarted()) {
        input.onFinalError(error);
        return;
      }

      // 凭证失效：先尝试刷新同一账号的凭据。
      if (error instanceof UpstreamAuthError && input.refresh) {
        input.onAuthRefresh?.(plan.target, error.httpStatus);
        const refreshed = await input.refresh(plan.target);
        if (refreshed) {
          try {
            await input.attempt({ ...plan.target, session: refreshed }, signal);
            return;
          } catch (retryError) {
            input.onRefreshRetryFailed?.(retryError);
            error = retryError;
          }
        }
      }

      const cause = classifyMigrationCause(error);
      if (!cause) {
        input.onFinalError(error);
        return;
      }

      // 换账号：原账号进入冷却，后续请求不再选它。
      markAccountCoolingDown(plan.target.accountId, cause);
      lastError = error;
      input.onMigrate?.({
        fromAccountId: plan.target.accountId,
        cause,
        attempted: attempted.size,
      });
      // 继续下一轮：planRoute 会排除已尝试过的账号
    }
  }

  input.onFinalError(
    lastError ??
      new NoUsableAccountError(
        "No available provider account for this API key. " +
          "All bound accounts are revoked, invalid, or have no usable session.",
      ),
  );
}
