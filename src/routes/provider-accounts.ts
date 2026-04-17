import type { Request, Response } from "express";
import {
  deleteSession,
  refreshStoredSession,
} from "../auth/huawei/session-store";
import {
  deleteProviderAccount,
  getProviderAccount,
  listProviderAccounts,
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
  const ok = deleteProviderAccount(auth.userId, providerAccountId);
  if (!ok) {
    res.status(404).json(createOpenAIError("Provider account not found"));
    return;
  }

  deleteSession(providerAccountId);
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

  try {
    const session = await refreshStoredSession(providerAccountId);
    res.json({ data: session });
  } catch (error) {
    console.error("Manual provider account refresh failed:", error);
    res
      .status(502)
      .json(createOpenAIError("Manual refresh failed", "upstream_error"));
  }
}
