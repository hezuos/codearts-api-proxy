/**
 * API Key 作用域。
 *
 * - `account`：绑定具体账号（旧数据的隐含语义）；
 * - `user`：用户级 Key，不绑定单一账号，聚合该用户的可用账号池。
 */
export type ApiKeyScope = "account" | "user";

/**
 * 分配粒度（仅用户级 Key 使用）。
 *
 * - `conversation`：对话连续——同一对话固定使用同一账号；
 * - `request`：按请求轮询——每个请求重新分配账号。
 */
export type BalancingPolicy = "conversation" | "request";

export interface ApiKey {
  id: string;
  userId: string;
  /** 首选账号；用户级 Key 为空。旧数据的单账号语义由该字段承载。 */
  providerAccountId?: string;
  /**
   * 显式绑定的账号列表。
   *
   * 账号级 Key 可绑定多个账号；用户级 Key 为空——其候选集在每次请求时
   * 按该用户的可用账号动态求值。
   */
  providerAccountIds?: string[];
  /** 作用域；旧数据缺省按 `account` 解释。 */
  scope?: ApiKeyScope;
  /** 分配粒度；旧数据缺省按 `conversation` 解释。 */
  balancingPolicy?: BalancingPolicy;
  keyHash: string;
  name: string;
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
}
