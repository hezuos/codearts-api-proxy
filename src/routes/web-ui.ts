import type { Request, Response } from "express";
import {
  getUser,
  listProviderAccounts,
  issueApiKey,
  revokeApiKey as revokeStoreApiKey,
  deleteProviderAccount,
  setDefaultProviderAccount,
  getProviderAccount,
  listApiKeysByUser,
} from "../auth/store";
import {
  getSession,
  deleteSession,
  refreshStoredSession,
} from "../auth/huawei/session-store";
import { randomUUID } from "crypto";

/**
 * GET /success - Success page after OAuth login
 */
export function successPage(_req: Request, res: Response): void {
  res.sendFile("success.html", { root: "public" });
}

/**
 * GET /api/ui/account - Get current user's account information
 */
export function getAccountInfo(req: Request, res: Response): void {
  const auth = req.uiAuth;
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const user = getUser(auth.userId);
  const accounts = listProviderAccounts(auth.userId);
  const defaultAccount = accounts.find((a) => a.isDefault) || accounts[0];

  // Get session info for the default account
  const session = defaultAccount ? getSession(defaultAccount.id) : null;

  res.json({
    apiKey: req.cookies.auth_key,
    userName: defaultAccount?.providerUserName,
    domainId: defaultAccount?.domainId,
    accountId: defaultAccount?.providerUserId,
    user: {
      id: user?.id,
      email: user?.email,
      displayName: user?.displayName,
    },
    account: defaultAccount
      ? {
          id: defaultAccount.id,
          provider: defaultAccount.provider,
          displayName: defaultAccount.displayName,
          isDefault: defaultAccount.isDefault,
          status: defaultAccount.status,
        }
      : null,
    session: session
      ? {
          expiresAt: session.expiresAt,
          hasBusinessToken: !!session.businessToken,
        }
      : null,
  });
}

/**
 * GET /api/ui/status - Get user's account status
 */
export function getAccountStatus(req: Request, res: Response): void {
  const auth = req.uiAuth;
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const user = getUser(auth.userId);
  const accounts = listProviderAccounts(auth.userId);

  const accountsWithStatus = accounts.map((account) => {
    const session = getSession(account.id);
    return {
      id: account.id,
      provider: account.provider,
      displayName: account.displayName,
      providerUserName: account.providerUserName,
      domainId: account.domainId,
      providerUserId: account.providerUserId,
      isDefault: account.isDefault,
      status: account.status,
      session: session
        ? {
            expiresAt: session.expiresAt,
            hasBusinessToken: !!session.businessToken,
            lastRefreshedAt: session.lastRefreshedAt,
          }
        : null,
    };
  });

  res.json({
    apiKey: req.cookies.auth_key,
    user: {
      id: user?.id,
      email: user?.email,
      displayName: user?.displayName,
    },
    accounts: accountsWithStatus,
  });
}

/**
 * POST /api/ui/regenerate-key - Regenerate user's API key
 */
export function regenerateApiKey(req: Request, res: Response): void {
  const auth = req.uiAuth;
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Revoke all existing active keys for this user
  const existingKeys = listApiKeysByUser(auth.userId);
  for (const key of existingKeys) {
    if (!key.revokedAt) {
      revokeStoreApiKey(key.id);
    }
  }

  // Generate and issue new API key
  // Bind to the same provider account as the current key, or the user's default
  const accounts = listProviderAccounts(auth.userId);
  const defaultAccount = accounts.find((a) => a.isDefault) ?? accounts[0];
  const newKey = `sk-${randomUUID()}`;
  const apiKey = issueApiKey({
    userId: auth.userId,
    providerAccountId: auth.providerAccountId ?? defaultAccount?.id,
    name: "regenerated",
    rawKey: newKey,
  });

  // Update cookie
  const isProduction = process.env.NODE_ENV === "production";
  res.cookie("auth_key", newKey, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });

  res.json({
    apiKey: newKey,
    apiKeyId: apiKey.id,
  });
}

/**
 * POST /api/ui/accounts/:accountId/refresh - Refresh account token (cookie auth)
 */
export async function refreshAccountToken(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = req.uiAuth;
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { accountId } = req.params;
  const account = getProviderAccount(accountId);

  if (!account || account.userId !== auth.userId) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  try {
    const session = await refreshStoredSession(accountId);
    res.json({ success: true, session });
  } catch (error) {
    console.error("Manual account refresh failed:", error);
    res.status(502).json({ error: "Refresh failed" });
  }
}

/**
 * DELETE /api/ui/accounts/:accountId - Unbind account (cookie auth)
 */
export function unbindAccount(req: Request, res: Response): void {
  const auth = req.uiAuth;
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { accountId } = req.params;

  // Prevent unbinding the last account
  const accounts = listProviderAccounts(auth.userId);
  if (accounts.length <= 1) {
    res.status(400).json({ error: "Cannot unbind the last account" });
    return;
  }

  const ok = deleteProviderAccount(auth.userId, accountId);
  if (!ok) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  deleteSession(accountId);
  res.status(204).end();
}

/**
 * POST /api/ui/accounts/:accountId/default - Set default account (cookie auth)
 */
export function setDefaultAccount(req: Request, res: Response): void {
  const auth = req.uiAuth;
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { accountId } = req.params;
  const account = setDefaultProviderAccount(auth.userId, accountId);

  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  res.json({ success: true, account });
}
