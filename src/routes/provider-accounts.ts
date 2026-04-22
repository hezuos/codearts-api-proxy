import type { Request, Response } from "express";
import {
  refreshStoredSession,
} from "../auth/huawei/session-store";
import {
  deleteProviderAccount,
  getProviderAccount,
  listProviderAccounts,
  listApiKeysByUser,
  setDefaultProviderAccount,
} from "../auth/store";
import { getRequestAuth } from "../middleware/authenticate-api-key";
import { createOpenAIError } from "../utils/openai-error";

export function listBoundProviderAccounts(req: Request, res: Response): void {
  const auth = getRequestAuth(req);
  res.json({ data: listProviderAccounts(auth.userId) });
}

export function selectDefaultProviderAccount(
  req: Request,
  res: Response,
): void {
  const auth = getRequestAuth(req);
  const providerAccountId = req.params.providerAccountId;
  const providerAccount = setDefaultProviderAccount(
    auth.userId,
    providerAccountId,
  );
  if (!providerAccount) {
    res.status(404).json(createOpenAIError("Provider account not found"));
    return;
  }

  res.json({ data: providerAccount });
}

export function unbindProviderAccount(req: Request, res: Response): void {
  const auth = getRequestAuth(req);
  const providerAccountId = req.params.providerAccountId;
  // deleteProviderAccount cascades to keys + sessions
  const ok = deleteProviderAccount(auth.userId, providerAccountId);
  if (!ok) {
    res.status(404).json(createOpenAIError("Provider account not found"));
    return;
  }

  res.status(204).end();
}

export async function triggerProviderAccountRefresh(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = getRequestAuth(req);
  const providerAccountId = req.params.providerAccountId;
  const providerAccount = getProviderAccount(providerAccountId);

  if (!providerAccount || providerAccount.userId !== auth.userId) {
    res.status(404).json(createOpenAIError("Provider account not found"));
    return;
  }

  // Refresh all active keys' sessions for this account
  const userKeys = listApiKeysByUser(auth.userId);
  const accountKeys = userKeys.filter(
    (k) => !k.revokedAt && k.providerAccountId === providerAccountId,
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

  res.json({ data: results });
}
