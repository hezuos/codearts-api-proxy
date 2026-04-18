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
} from "../auth/store";
import { getSession, refreshStoredSession } from "../auth/huawei/session-store";

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
 * Spec: system SHALL redirect to home page "/"
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
 * GET /admin/api/users - Get all users with their accounts (no API keys)
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

/**
 * GET /admin/api/accounts - Get all accounts with session details
 */
export function getAllAccounts(_req: Request, res: Response): void {
  const users = listAllUsers();

  const accounts = users.flatMap((user) => {
    const userAccounts = listProviderAccounts(user.id);
    const userApiKeys = listApiKeysByUser(user.id);
    return userAccounts.map((account) => {
      const session = getSession(account.id);
      // Find all API keys bound to this account (active + revoked)
      const accountApiKeys = userApiKeys
        .filter((k) => k.providerAccountId === account.id)
        .map((k) => ({
          id: k.id,
          keyHash: k.keyHash,
          name: k.name,
          createdAt: k.createdAt,
          revokedAt: k.revokedAt ?? null,
        }));
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
        session: session
          ? {
              expiresAt: session.expiresAt,
              lastRefreshedAt: session.lastRefreshedAt,
            }
          : null,
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
 * GET /admin/api/accounts/:id - Get single account details
 */
export function getAccountDetails(req: Request, res: Response): void {
  const accountId = req.params.id;
  const users = listAllUsers();

  for (const user of users) {
    const accounts = listProviderAccounts(user.id);
    const account = accounts.find((a) => a.id === accountId);
    if (account) {
      const session = getSession(account.id);
      const userApiKeys = listApiKeysByUser(user.id);
      const accountApiKeys = userApiKeys
        .filter((k) => k.providerAccountId === account.id)
        .map((k) => ({
          id: k.id,
          keyHash: k.keyHash,
          name: k.name,
          createdAt: k.createdAt,
          revokedAt: k.revokedAt ?? null,
        }));
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
        session: session
          ? {
              expiresAt: session.expiresAt,
              lastRefreshedAt: session.lastRefreshedAt,
            }
          : null,
      });
      return;
    }
  }

  res.status(404).json({ error: "Account not found" });
}

/**
 * POST /admin/api/accounts/:id/refresh - Force refresh account token
 */
export async function forceRefreshAccount(
  req: Request,
  res: Response,
): Promise<void> {
  const accountId = req.params.id;

  try {
    const session = await refreshStoredSession(accountId);
    if (!session) {
      res.status(404).json({ error: "Account session not found" });
      return;
    }
    res.json({ success: true, accountId, session });
  } catch (error) {
    console.error(
      `[admin] Force refresh failed for account ${accountId}:`,
      error,
    );
    res.status(502).json({ error: "Refresh failed" });
  }
}
