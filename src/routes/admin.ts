import type { Request, Response } from "express";
import {
  saveAdminConfig,
  checkAdminPassword,
  isAdminConfigured,
  updateLastLogin,
} from "../auth/admin";
import { logger } from "../utils/logger";
import {
  setAdminSession,
  clearAdminSession,
} from "../middleware/authenticate-admin";
import {
  listAllUsers,
  listProviderAccounts,
  listApiKeysByUser,
  revokeApiKey as revokeStoreApiKey,
  deleteProviderAccount,
  deleteKey as deleteStoreKey,
  getApiKey,
  getKeyLocation,
  issueApiKey,
  persistApiKey,
  resolveBalancingPolicy,
  resolveKeyScope,
  resolveBoundAccountIds,
  setSession,
  deleteSession,
  getAllApiKeys,
} from "../auth/store";
import {
  hasFreeSlot,
  listAccountCooldowns,
} from "../routing/account-selector";
import { randomUUID } from "crypto";
import {
  getSession,
  refreshStoredSession,
} from "../auth/huawei/session-store";
import type { ApiKey } from "../db/models/api-key";
import type { StoredHuaweiSession } from "../auth/huawei/session-store";
import type { ProviderAccount } from "../db/models/provider-account";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Find the user who owns a given account. */
function findAccountOwner(accountId: string): { userId: string; account: ProviderAccount } | null {
  for (const user of listAllUsers()) {
    const account = listProviderAccounts(user.id).find((a) => a.id === accountId);
    if (account) return { userId: user.id, account };
  }
  return null;
}

/** Determine session status from expiresAt */
function sessionStatus(
  expiresAt?: string,
): "active" | "expiring" | "expired" | "missing" {
  if (!expiresAt) return "missing";
  const expires = new Date(expiresAt).getTime();
  if (Number.isNaN(expires)) return "missing";
  const remaining = expires - Date.now();
  if (remaining <= 0) return "expired";
  if (remaining < 2 * 60 * 60 * 1000) return "expiring";
  return "active";
}

/** Map an ApiKey + its session to the admin API response shape. */
function mapApiKeyDetails(k: ApiKey, keySession: StoredHuaweiSession | undefined) {
  const scope = resolveKeyScope(k);
  return {
    id: k.id,
    // 列表接口只暴露哈希——原始密钥仅在创建响应中一次性返回
    keyHash: k.keyHash,
    name: k.name,
    scope,
    balancingPolicy: scope === "user" ? resolveBalancingPolicy(k) : null,
    providerAccountId: k.providerAccountId ?? null,
    providerAccountIds: k.providerAccountIds ?? [],
    createdAt: k.createdAt,
    revokedAt: k.revokedAt ?? null,
    sessionStatus: sessionStatus(keySession?.expiresAt),
    session: keySession
      ? {
          expiresAt: keySession.expiresAt,
          lastRefreshedAt: keySession.lastRefreshedAt,
        }
      : null,
  };
}

/** 用户级 Key 的展示形态——独立分区，显式标注作用域与分配粒度。 */
function mapUserScopedKey(k: ApiKey) {
  return {
    id: k.id,
    userId: k.userId,
    keyHash: k.keyHash,
    name: k.name,
    scope: "user" as const,
    balancingPolicy: resolveBalancingPolicy(k),
    createdAt: k.createdAt,
    revokedAt: k.revokedAt ?? null,
  };
}

/** 账号健康状态与冷却剩余时间。 */
function buildAccountHealth(
  accountId: string,
  cooldowns: Map<string, { reason: string; remainingMs: number }>,
) {
  const cooldown = cooldowns.get(accountId);
  return {
    cooldownMs: cooldown?.remainingMs ?? 0,
    cooldownReason: cooldown?.reason ?? null,
    hasFreeSlot: hasFreeSlot(accountId),
  };
}

/** Build account API keys details for a given user + account. */
function buildAccountApiKeys(userId: string, accountId: string) {
  return listApiKeysByUser(userId)
    .filter((k) => k.providerAccountId === accountId)
    .map((k) => mapApiKeyDetails(k, getSession(k.id)));
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /admin/setup - Admin setup page
 */
export function adminSetupPage(_req: Request, res: Response): void {
  res.sendFile("admin-setup.html", { root: "public" });
}

/**
 * POST /admin/setup - Set admin password
 */
export function adminSetup(req: Request, res: Response): void {
  if (isAdminConfigured()) {
    res.status(400).json({ error: "Admin already configured" });
    return;
  }

  const { password } = req.body;
  if (!password || typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  saveAdminConfig(password);
  setAdminSession(res);
  res.json({ success: true });
}

/**
 * GET /admin/login - Admin login page
 */
export function adminLoginPage(_req: Request, res: Response): void {
  res.sendFile("admin-login.html", { root: "public" });
}

/**
 * POST /admin/login - Admin login
 */
export function adminLogin(req: Request, res: Response): void {
  const { password } = req.body;

  if (!password || typeof password !== "string") {
    res.status(400).json({ error: "Password required" });
    return;
  }

  if (!checkAdminPassword(password)) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  updateLastLogin();
  setAdminSession(res);
  res.json({ success: true });
}

/**
 * POST /admin/logout - Admin logout
 */
export function adminLogout(_req: Request, res: Response): void {
  clearAdminSession(res);
  res.redirect("/");
}

/**
 * GET /admin - Admin panel page
 */
export function adminPanel(_req: Request, res: Response): void {
  res.sendFile("admin.html", { root: "public" });
}

/**
 * GET /admin/api/users - Get all users with their accounts
 */
export function getAllUsers(_req: Request, res: Response): void {
  const users = listAllUsers();

  const result = users.map((user) => {
    const accounts = listProviderAccounts(user.id);
    // 用户级 Key 独立于账号密钥列表，按用户维度分区呈现
    const userKeys = listApiKeysByUser(user.id)
      .filter((k) => resolveKeyScope(k) === "user")
      .map((k) => mapUserScopedKey(k));

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      createdAt: user.createdAt,
      accounts: accounts.map((a) => ({
        id: a.id,
        provider: a.provider,
        displayName: a.displayName,
      })),
      userKeys,
    };
  });

  res.json({ users: result });
}

/**
 * GET /admin/api/accounts - Get all accounts with key+session details
 */
export function getAllAccounts(_req: Request, res: Response): void {
  const users = listAllUsers();
  const cooldowns = new Map(
    listAccountCooldowns().map((c) => [
      c.accountId,
      { reason: c.reason, remainingMs: c.remainingMs },
    ]),
  );

  const accounts = users.flatMap((user) => {
    const userAccounts = listProviderAccounts(user.id);
    return userAccounts.map((account) => ({
      id: account.id,
      userId: account.userId,
      userDisplayName: user.displayName,
      provider: account.provider,
      displayName: account.displayName,
      providerUserName: account.providerUserName,
      domainId: account.domainId,
      providerUserId: account.providerUserId,
      isDefault: account.isDefault,
      status: account.status,
      health: buildAccountHealth(account.id, cooldowns),
      apiKeys: buildAccountApiKeys(user.id, account.id),
    }));
  });

  res.json({ accounts });
}

/**
 * POST /admin/api/keys/:id/revoke - Revoke API key
 */
export function revokeApiKey(req: Request, res: Response): void {
  const keyId = String(req.params.id);
  const ok = revokeStoreApiKey(keyId);

  if (!ok) {
    res.status(404).json({ error: "API key not found or already revoked" });
    return;
  }

  res.json({ success: true, keyId });
}

/**
 * DELETE /admin/api/keys/:id - Delete API key (cascade deletes session)
 */
export function deleteApiKey(req: Request, res: Response): void {
  const keyId = String(req.params.id);
  const apiKey = getApiKey(keyId);
  if (!apiKey) {
    res.status(404).json({ error: "API key not found" });
    return;
  }

  const loc = getKeyLocation(keyId);
  if (!loc) {
    res.status(404).json({ error: "Key location not found" });
    return;
  }

  // 按作用域分支：用户级 Key 的文件在用户级目录，不能按 accountId 拼路径，
  // 否则磁盘文件残留，重启后 Key 复活。
  deleteStoreKey(loc.userId, loc.accountId, keyId, loc.scope);
  logger.info(`[admin] Key deleted: ${keyId}`);
  res.json({ success: true, keyId });
}

/**
 * POST /admin/api/keys/:id/refresh - Refresh session for a single key
 */
export async function refreshApiKey(
  req: Request,
  res: Response,
): Promise<void> {
  const keyId = String(req.params.id);
  const apiKey = getApiKey(keyId);
  if (!apiKey) {
    res.status(404).json({ error: "API key not found" });
    return;
  }

  if (apiKey.revokedAt) {
    res.status(400).json({ error: "Cannot refresh revoked key" });
    return;
  }

  // 用户级 Key 没有自有凭据——它借用被选中账号的会话，因此无从刷新。
  // 返回明确的 4xx 与说明，而不是 500。
  if (resolveKeyScope(apiKey) === "user") {
    res.status(400).json({
      error: "User-scoped keys have no credentials of their own",
      detail:
        "该 Key 无自有凭据——它借用被选中账号的会话。请刷新对应账号的会话。",
    });
    return;
  }

  try {
    await refreshStoredSession(keyId, apiKey.providerAccountId);
    res.json({ success: true, keyId });
  } catch (error) {
    res.status(500).json({ error: `Refresh failed: ${String(error)}` });
  }
}

/**
 * GET /admin/api/accounts/:id - Get single account details
 */
export function getAccountDetails(req: Request, res: Response): void {
  const accountId = String(req.params.id);
  const owner = findAccountOwner(accountId);

  if (!owner) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  const { userId, account } = owner;
  const user = listAllUsers().find((u) => u.id === userId);

  res.json({
    id: account.id,
    userId: account.userId,
    userDisplayName: user?.displayName,
    provider: account.provider,
    displayName: account.displayName,
    providerUserName: account.providerUserName,
    domainId: account.domainId,
    providerUserId: account.providerUserId,
    isDefault: account.isDefault,
    status: account.status,
    apiKeys: buildAccountApiKeys(userId, account.id),
  });
}

/**
 * POST /admin/api/accounts/:id/refresh - Force refresh all keys' sessions for an account
 */
export async function forceRefreshAccount(
  req: Request,
  res: Response,
): Promise<void> {
  const accountId = String(req.params.id);
  const owner = findAccountOwner(accountId);

  if (!owner) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  const accountKeys = listApiKeysByUser(owner.userId).filter(
    (k) => !k.revokedAt && k.providerAccountId === accountId,
  );

  const results: Array<{ keyId: string; success: boolean; error?: string }> = [];
  for (const key of accountKeys) {
    try {
      await refreshStoredSession(key.id);
      results.push({ keyId: key.id, success: true });
    } catch (error) {
      results.push({ keyId: key.id, success: false, error: String(error) });
    }
  }

  res.json({ success: true, accountId, results });
}

/**
 * DELETE /admin/api/accounts/:id - Delete account (cascade deletes keys + sessions)
 */

/**
 * 为 Key 的每个绑定账号复制一份可用会话。
 *
 * 新建的账号级 Key 自身没有登录凭据——从该账号下已有的账号级 Key 借用，
 * 使新 Key 立即可用（与"重新生成账号密钥"的语义一致）。
 */
function inheritSessions(
  userId: string,
  keyId: string,
  accountIds: string[],
): number {
  const sourceKeys = listApiKeysByUser(userId).filter(
    (k) =>
      resolveKeyScope(k) === "account" && !k.revokedAt && k.id !== keyId,
  );
  let copied = 0;
  for (const accountId of accountIds) {
    for (const source of sourceKeys) {
      const session = getSession(source.id, accountId);
      if (!session) continue;
      setSession(keyId, { ...session, keyId });
      copied++;
      break;
    }
  }
  return copied;
}

/**
 * GET /admin/api/user-keys - 列出全部用户级 Key（只含哈希）
 */
export function listUserScopedKeys(_req: Request, res: Response): void {
  const userKeys = getAllApiKeys()
    .filter((k) => resolveKeyScope(k) === "user")
    .map((k) => mapUserScopedKey(k));
  res.json({ userKeys });
}

/**
 * POST /admin/api/users/:userId/user-keys - 创建用户级 Key
 *
 * 用户级 Key 只能通过管理界面创建——华为账号登录流程 SHALL NOT 签发用户级 Key。
 * 原始密钥在创建响应中一次性返回，列表接口只暴露哈希。
 */
export function createUserScopedKey(req: Request, res: Response): void {
  const userId = String(req.params.userId);
  const user = listAllUsers().find((u) => u.id === userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const body = req.body as { name?: string; balancingPolicy?: string };
  // 分配粒度缺省为"对话连续"
  const policy = body.balancingPolicy === "request" ? "request" : "conversation";
  const rawKey = `sk-${randomUUID()}`;
  const apiKey = issueApiKey({
    userId,
    scope: "user",
    balancingPolicy: policy,
    name: body.name?.trim() || "user-scoped",
    rawKey,
  });

  logger.info(
    `[admin] User-scoped key created: ${apiKey.id} user=${userId} policy=${policy}`,
  );
  res.json({
    id: apiKey.id,
    // 原始密钥仅此一次返回
    apiKey: rawKey,
    name: apiKey.name,
    scope: "user",
    balancingPolicy: policy,
    keyHash: apiKey.keyHash,
  });
}

/**
 * POST /admin/api/keys - 创建账号级 Key（支持绑定多个账号）
 */
export function createAccountApiKey(req: Request, res: Response): void {
  const body = req.body as {
    userId?: string;
    name?: string;
    providerAccountId?: string;
    providerAccountIds?: string[];
  };
  const userId = String(body.userId ?? "");
  const user = listAllUsers().find((u) => u.id === userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const userAccounts = listProviderAccounts(userId);
  const requested = Array.isArray(body.providerAccountIds)
    ? body.providerAccountIds.filter((id) =>
        userAccounts.some((a) => a.id === id),
      )
    : [];
  const preferred = body.providerAccountId ?? requested[0];
  if (!preferred || !userAccounts.some((a) => a.id === preferred)) {
    res.status(400).json({ error: "A valid preferred account is required" });
    return;
  }

  const bound = requested.length > 0 ? requested : [preferred];
  const finalBound = bound.includes(preferred) ? bound : [preferred, ...bound];

  const rawKey = `sk-${randomUUID()}`;
  const apiKey = issueApiKey({
    userId,
    providerAccountId: preferred,
    providerAccountIds: finalBound,
    name: body.name?.trim() || "admin-created",
    rawKey,
  });

  const inherited = inheritSessions(userId, apiKey.id, finalBound);
  logger.info(
    `[admin] Account-scoped key created: ${apiKey.id} user=${userId} accounts=${finalBound.join(",")} sessions=${inherited}`,
  );
  res.json({
    id: apiKey.id,
    apiKey: rawKey,
    name: apiKey.name,
    scope: "account",
    providerAccountId: preferred,
    providerAccountIds: finalBound,
    inheritedSessions: inherited,
  });
}

/**
 * PATCH /admin/api/keys/:id/accounts - 编辑账号级 Key 的绑定账号
 */
export function updateKeyAccounts(req: Request, res: Response): void {
  const keyId = String(req.params.id);
  const apiKey = getApiKey(keyId);
  if (!apiKey) {
    res.status(404).json({ error: "API key not found" });
    return;
  }
  if (resolveKeyScope(apiKey) !== "account") {
    res.status(400).json({
      error: "Only account-scoped keys have bound accounts",
    });
    return;
  }

  const body = req.body as {
    providerAccountId?: string;
    providerAccountIds?: string[];
  };
  const userId = apiKey.userId;
  const userAccounts = listProviderAccounts(userId);
  const requested = Array.isArray(body.providerAccountIds)
    ? body.providerAccountIds.filter((id) =>
        userAccounts.some((a) => a.id === id),
      )
    : [];
  const preferred = body.providerAccountId ?? requested[0];
  if (!preferred || !userAccounts.some((a) => a.id === preferred)) {
    res.status(400).json({ error: "A valid preferred account is required" });
    return;
  }

  const bound = requested.length > 0 ? requested : [preferred];
  const finalBound = bound.includes(preferred) ? bound : [preferred, ...bound];
  const previous = resolveBoundAccountIds(apiKey);

  apiKey.providerAccountId = preferred;
  apiKey.providerAccountIds = finalBound;
  apiKey.updatedAt = new Date().toISOString();
  persistApiKey(apiKey);

  // 新绑定的账号复制一份可用会话；解绑的账号清掉自己的会话
  inheritSessions(
    userId,
    keyId,
    finalBound.filter((id) => !previous.includes(id)),
  );
  for (const removed of previous.filter((id) => !finalBound.includes(id))) {
    deleteSession(keyId, removed);
  }

  logger.info(
    `[admin] Key account binding updated: ${keyId} -> ${finalBound.join(",")}`,
  );
  res.json({
    success: true,
    keyId,
    providerAccountId: preferred,
    providerAccountIds: finalBound,
  });
}

/**
 * PATCH /admin/api/keys/:id/policy - 切换用户级 Key 的分配粒度
 */
export function updateKeyPolicy(req: Request, res: Response): void {
  const keyId = String(req.params.id);
  const apiKey = getApiKey(keyId);
  if (!apiKey) {
    res.status(404).json({ error: "API key not found" });
    return;
  }
  if (resolveKeyScope(apiKey) !== "user") {
    res.status(400).json({
      error: "Only user-scoped keys have an allocation granularity",
    });
    return;
  }

  const body = req.body as { balancingPolicy?: string };
  const policy = body.balancingPolicy === "request" ? "request" : "conversation";
  apiKey.balancingPolicy = policy;
  apiKey.updatedAt = new Date().toISOString();
  persistApiKey(apiKey);

  logger.info(`[admin] User-scoped key policy updated: ${keyId} -> ${policy}`);
  res.json({ success: true, keyId, balancingPolicy: policy });
}

export function deleteAccount(req: Request, res: Response): void {
  const accountId = String(req.params.id);
  const owner = findAccountOwner(accountId);

  if (!owner) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  const ok = deleteProviderAccount(owner.userId, accountId);
  if (!ok) {
    res.status(500).json({ error: "Failed to delete account" });
    return;
  }

  logger.info(
    `[admin] Account deleted: ${accountId} (user: ${owner.userId})`,
  );

  res.json({ success: true, accountId });
}
