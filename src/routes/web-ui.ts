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
  getSessionByKeyId,
  setSession,
} from "../auth/store";
import {
  getSession,
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

  // Get session info from the first active key of the default account
  const userKeys = listApiKeysByUser(auth.userId);
  const defaultKey = userKeys.find(
    (k) => !k.revokedAt && k.providerAccountId === defaultAccount?.id,
  );
  const session = defaultKey ? getSession(defaultKey.id) : null;

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
  const userKeys = listApiKeysByUser(auth.userId);

  const accountsWithStatus = accounts.map((account) => {
    // Find first active key for this account
    const accountKey = userKeys.find(
      (k) => !k.revokedAt && k.providerAccountId === account.id,
    );
    const session = accountKey ? getSession(accountKey.id) : null;
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
 * Copies the current key's session to the new key (1:1).
 */
export function regenerateApiKey(req: Request, res: Response): void {
  const auth = req.uiAuth;
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Find the current active key to copy its session
  const existingKeys = listApiKeysByUser(auth.userId);
  const currentKey = existingKeys.find(
    (k) => !k.revokedAt && k.keyHash === req.cookies.auth_key,
  );
  const currentSession = currentKey
    ? getSessionByKeyId(currentKey.id)
    : null;

  // Revoke all existing active keys for this user
  for (const key of existingKeys) {
    if (!key.revokedAt) {
      revokeStoreApiKey(key.id);
    }
  }

  // Generate and issue new API key bound to the same account
  const accounts = listProviderAccounts(auth.userId);
  const defaultAccount = accounts.find((a) => a.isDefault) ?? accounts[0];
  const accountId =
    currentKey?.providerAccountId ?? defaultAccount?.id ?? "";
  const newKey = `sk-${randomUUID()}`;
  const apiKey = issueApiKey({
    userId: auth.userId,
    providerAccountId: accountId,
    name: "regenerated",
    rawKey: newKey,
  });

  // Copy the current session to the new key (1:1)
  if (currentSession) {
    setSession(apiKey.id, {
      ...currentSession,
      keyId: apiKey.id,
    });
  }

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
 * Refreshes all active keys' sessions for this account.
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

  // Refresh all active keys' sessions for this account
  const userKeys = listApiKeysByUser(auth.userId);
  const accountKeys = userKeys.filter(
    (k) => !k.revokedAt && k.providerAccountId === accountId,
  );

  const results = [];
  for (const key of accountKeys) {
    try {
      const session = await refreshStoredSession(key.id);
      results.push({ keyId: key.id, success: true, session });
    } catch (error) {
      results.push({ keyId: key.id, success: false, error: String(error) });
    }
  }

  res.json({ success: true, results });
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

  // Session deletion is handled by cascade in hierarchical-store
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
