import { randomUUID } from "crypto";
import type { ApiKey, ApiKeyScope, BalancingPolicy } from "../db/models/api-key";
import type { StoredHuaweiSession } from "../auth/huawei/session-store";
import {
  getApiKey,
  setApiKey,
  persistApiKey,
  findApiKeyByValue,
  getSessionByKeyId,
  getAllApiKeys,
  getKeyLocation,
  hashApiKey,
  resolveKeyScope,
  resolveBoundAccountIds,
} from "../store/hierarchical-store";

// ---------------------------------------------------------------------------
// AuthContext —— 判别联合
// ---------------------------------------------------------------------------

/**
 * 账号级鉴权上下文：Key 绑定具体账号，携带该账号的会话。
 */
export interface AccountAuthContext {
  kind: "account";
  apiKeyId: string;
  userId: string;
  providerAccountId: string;
  session: StoredHuaweiSession;
}

/**
 * 用户级鉴权上下文：Key 聚合该用户的账号池。
 *
 * 不携带会话——凭据由请求入口按分配策略从被选中账号借用。
 */
export interface AggregateAuthContext {
  kind: "aggregate";
  apiKeyId: string;
  userId: string;
  balancingPolicy: BalancingPolicy;
}

export type AuthContext = AccountAuthContext | AggregateAuthContext;

/** 归一化 Key 的分配粒度：旧数据缺省按"对话连续"解释。 */
export function resolveBalancingPolicy(key: ApiKey): BalancingPolicy {
  return key.balancingPolicy ?? "conversation";
}

// ---------------------------------------------------------------------------
// ApiKey operations
// ---------------------------------------------------------------------------

export function issueApiKey(input: {
  userId: string;
  /** 首选账号；用户级 Key 不传。 */
  providerAccountId?: string;
  /** 显式绑定的账号列表；用户级 Key 不传（候选集动态求值）。 */
  providerAccountIds?: string[];
  /** 作用域；缺省按账号级解释。 */
  scope?: ApiKeyScope;
  /** 分配粒度；缺省按"对话连续"解释。 */
  balancingPolicy?: BalancingPolicy;
  name: string;
  rawKey: string;
}): ApiKey {
  const now = new Date().toISOString();
  const scope: ApiKeyScope = input.scope ?? "account";
  const apiKey: ApiKey = {
    id: randomUUID(),
    userId: input.userId,
    // 实体只存 SHA-256 哈希——列表接口 SHALL NOT 泄露原始密钥。
    // 旧数据把明文存在 keyHash 里，由加载期的迁移逻辑补齐。
    keyHash: hashApiKey(input.rawKey),
    name: input.name,
    createdAt: now,
    updatedAt: now,
  };

  if (scope === "user") {
    apiKey.scope = "user";
    apiKey.balancingPolicy = input.balancingPolicy ?? "conversation";
  } else {
    apiKey.scope = "account";
    apiKey.providerAccountId = input.providerAccountId;
    if (input.providerAccountIds && input.providerAccountIds.length > 0) {
      apiKey.providerAccountIds = input.providerAccountIds;
    }
  }

  setApiKey(apiKey, input.rawKey);
  return apiKey;
}

/**
 * 校验原始密钥并返回鉴权上下文。
 *
 * 账号级 Key 要求有首选账号与可用会话；用户级 Key 不持有自有会话，
 * 因此不检查会话——其候选账号在请求入口按分配策略求值。
 */
export function validateApiKey(rawKey: string): AuthContext | null {
  const apiKey = findApiKeyByValue(rawKey);
  if (!apiKey || apiKey.revokedAt) {
    return null;
  }

  if (resolveKeyScope(apiKey) === "user") {
    return {
      kind: "aggregate",
      apiKeyId: apiKey.id,
      userId: apiKey.userId,
      balancingPolicy: resolveBalancingPolicy(apiKey),
    };
  }

  if (!apiKey.providerAccountId) {
    return null;
  }

  const session = getSessionByKeyId(apiKey.id);
  if (!session) {
    return null;
  }

  return {
    kind: "account",
    apiKeyId: apiKey.id,
    userId: apiKey.userId,
    providerAccountId: apiKey.providerAccountId,
    session,
  };
}

/**
 * 取该用户的账号级 Key 哈希。
 *
 * 只返回账号级 Key——加入用户级 Key 后，若不收窄，本函数可能返回用户级
 * Key 的哈希，语义会漂移。
 */
export function getUserApiKey(userId: string): string | null {
  for (const apiKey of getAllApiKeys()) {
    if (
      apiKey.userId === userId &&
      !apiKey.revokedAt &&
      resolveKeyScope(apiKey) === "account"
    ) {
      return apiKey.keyHash;
    }
  }
  return null;
}

/**
 * 吊销 Key。
 *
 * 吊销状态必须落盘——否则重启后 Key 会复活。仅更新内存索引是不够的。
 */
export function revokeApiKey(apiKeyId: string): boolean {
  const apiKey = getApiKey(apiKeyId);
  if (!apiKey || apiKey.revokedAt) {
    return false;
  }
  apiKey.revokedAt = new Date().toISOString();
  apiKey.updatedAt = new Date().toISOString();

  persistApiKey(apiKey);
  return true;
}

export function listApiKeysByUser(userId: string): ApiKey[] {
  return getAllApiKeys().filter((k) => k.userId === userId);
}

/** Key 显式绑定的账号列表（用户级 Key 返回空数组）。 */
export function listBoundAccountIds(apiKey: ApiKey): string[] {
  if (resolveKeyScope(apiKey) === "user") return [];
  return resolveBoundAccountIds(apiKey);
}

// ---------------------------------------------------------------------------
// Re-exports for hierarchical store access
// ---------------------------------------------------------------------------

export {
  getSessionByKeyId,
  getKeyLocation,
  getApiKey,
};
