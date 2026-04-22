import type { Request, Response } from "express";
import {
  saveAdminConfig,
  checkAdminPassword,
  isAdminConfigured,
  updateLastLogin,
} from "../auth/admin";
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
} from "../auth/store";
import {
  getSession,
  refreshStoredSession,
} from "../auth/huawei/session-store";

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
    };
  });

  res.json({ users: result });
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

/**
 * GET /admin/api/accounts - Get all accounts with key+session details
 */
export function getAllAccounts(_req: Request, res: Response): void {
  const users = listAllUsers();

  const accounts = users.flatMap((user) => {
    const userAccounts = listProviderAccounts(user.id);
    const userApiKeys = listApiKeysByUser(user.id);
    return userAccounts.map((account) => {
      // Find all API keys bound to this account (active + revoked)
      const accountApiKeys = userApiKeys
        .filter((k) => k.providerAccountId === account.id)
        .map((k) => {
          const keySession = getSession(k.id);
          return {
            id: k.id,
            keyHash: k.keyHash,
            name: k.name,
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
        });
      return {
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
        apiKeys: accountApiKeys,
      };
    });
  });

  res.json({ accounts });
}

/**
 * POST /admin/api/keys/:id/revoke - Revoke API key
 */
export function revokeApiKey(req: Request, res: Response): void {
  const keyId = req.params.id;
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
  const keyId = req.params.id;
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

  deleteStoreKey(loc.userId, loc.accountId, keyId);
  console.log(`[admin] Key deleted: ${keyId}`);
  res.json({ success: true, keyId });
}

/**
 * POST /admin/api/keys/:id/refresh - Refresh session for a single key
 */
export async function refreshApiKey(
  req: Request,
  res: Response,
): Promise<void> {
  const keyId = req.params.id;
  const apiKey = getApiKey(keyId);
  if (!apiKey) {
    res.status(404).json({ error: "API key not found" });
    return;
  }

  if (apiKey.revokedAt) {
    res.status(400).json({ error: "Cannot refresh revoked key" });
    return;
  }

  try {
    await refreshStoredSession(keyId);
    res.json({ success: true, keyId });
  } catch (error) {
    res.status(500).json({ error: `Refresh failed: ${String(error)}` });
  }
}

/**
 * GET /admin/api/accounts/:id - Get single account details
 */
export function getAccountDetails(req: Request, res: Response): void {
  const accountId = req.params.id;
  const users = listAllUsers();

  for (const user of users) {
    const accounts = listProviderAccounts(user.id);
    const account = accounts.find((a) => a.id === accountId);
    if (account) {
      const userApiKeys = listApiKeysByUser(user.id);
      const accountApiKeys = userApiKeys
        .filter((k) => k.providerAccountId === account.id)
        .map((k) => {
          const keySession = getSession(k.id);
          return {
            id: k.id,
            keyHash: k.keyHash,
            name: k.name,
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
        });
      res.json({
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
        apiKeys: accountApiKeys,
      });
      return;
    }
  }

  res.status(404).json({ error: "Account not found" });
}

/**
 * POST /admin/api/accounts/:id/refresh - Force refresh all keys' sessions for an account
 */
export async function forceRefreshAccount(
  req: Request,
  res: Response,
): Promise<void> {
  const accountId = req.params.id;

  // Find all active keys for this account
  const users = listAllUsers();
  let found = false;
  const results: Array<{ keyId: string; success: boolean; error?: string }> = [];

  for (const user of users) {
    const accounts = listProviderAccounts(user.id);
    if (accounts.find((a) => a.id === accountId)) {
      found = true;
      const userKeys = listApiKeysByUser(user.id);
      const accountKeys = userKeys.filter(
        (k) => !k.revokedAt && k.providerAccountId === accountId,
      );

      for (const key of accountKeys) {
        try {
          await refreshStoredSession(key.id);
          results.push({ keyId: key.id, success: true });
        } catch (error) {
          results.push({
            keyId: key.id,
            success: false,
            error: String(error),
          });
        }
      }
      break;
    }
  }

  if (!found) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  res.json({ success: true, accountId, results });
}

/**
 * DELETE /admin/api/accounts/:id - Delete account (cascade deletes keys + sessions)
 */
export function deleteAccount(req: Request, res: Response): void {
  const accountId = req.params.id;

  // 查找账户所属用户
  const users = listAllUsers();
  let targetUserId: string | null = null;

  for (const user of users) {
    const accounts = listProviderAccounts(user.id);
    if (accounts.find((a) => a.id === accountId)) {
      targetUserId = user.id;
      break;
    }
  }

  if (!targetUserId) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  // 删除账户（级联删除 keys + sessions）
  const ok = deleteProviderAccount(targetUserId, accountId);
  if (!ok) {
    res.status(500).json({ error: "Failed to delete account" });
    return;
  }

  console.log(
    `[admin] Account deleted: ${accountId} (user: ${targetUserId})`,
  );

  res.json({ success: true, accountId });
}
