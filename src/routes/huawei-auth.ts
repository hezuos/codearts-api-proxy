import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { encryptString } from "../auth/crypto/encryption";
import { createHuaweiLoginFlow } from "../auth/huawei/login-flow";
import { storeSession } from "../auth/huawei/session-store";
import { config } from "../config";
import { getRequestAuth } from "../middleware/authenticate-api-key";
import { getTraceId } from "../middleware/request-context";
import {
  getDefaultUser,
  upsertProviderAccount,
  listProviderAccounts,
  issueApiKey,
} from "../auth/store";
import {
  waitForHuaweiTicketExchange,
  type HuaweiTicketExchangeResponse,
} from "../upstream/huawei/ticket";
import { createOpenAIError } from "../utils/openai-error";

const loginFlows = new Map<
  string,
  {
    ticketId: string;
    state: string;
    expiresAt: number;
    userId: string;
    identifier?: string;
    redirect?: string;
  }
>();
let latestBrowserFlowTicketId: string | null = null;

function maskValue(value: string | undefined): string {
  if (!value) {
    return "missing";
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}***`;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function getPendingLoginFlow(ticketId?: string): {
  ticketId: string;
  state: string;
  expiresAt: number;
  userId: string;
  identifier?: string;
  redirect?: string;
} | null {
  if (ticketId) {
    return loginFlows.get(ticketId) ?? null;
  }

  if (latestBrowserFlowTicketId) {
    return loginFlows.get(latestBrowserFlowTicketId) ?? null;
  }

  const now = Date.now();
  const pending = Array.from(loginFlows.values())
    .filter((flow) => flow.expiresAt > now)
    .sort((left, right) => right.expiresAt - left.expiresAt);

  return pending[0] ?? null;
}

function getCallbackHost(req: Request): string {
  return `${req.protocol}://${req.get("host") ?? `127.0.0.1:${config.port}`}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForFlowIdentifier(ticketId: string): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const flow = loginFlows.get(ticketId);
    if (!flow) {
      throw new Error("Login flow not found");
    }

    if (Date.now() > flow.expiresAt) {
      throw new Error("Login flow expired");
    }

    if (flow.identifier) {
      console.log(
        `[huawei-auth] callback identifier ready ticketId=${maskValue(ticketId)} attempt=${attempt + 1} identifier=${maskValue(flow.identifier)} redirect=${flow.redirect ?? "missing"}`,
      );
      return flow.identifier;
    }

    if (attempt === 0 || (attempt + 1) % 5 === 0) {
      console.log(
        `[huawei-auth] waiting callback identifier ticketId=${maskValue(ticketId)} attempt=${attempt + 1}`,
      );
    }

    await sleep(1000);
  }

  throw new Error("Timed out waiting for Huawei callback identifier");
}

function completeLoginFlow(
  flow: {
    ticketId: string;
    state: string;
    expiresAt: number;
    userId: string;
    identifier?: string;
    redirect?: string;
  },
  result: HuaweiTicketExchangeResponse,
): { accountId: string; apiKey: string } {
  loginFlows.delete(flow.ticketId);
  if (latestBrowserFlowTicketId === flow.ticketId) {
    latestBrowserFlowTicketId = null;
  }

  // Use domainId to generate a unique, stable accountId for each Huawei account
  const accountId = result.domainId
    ? `huawei-${result.domainId}`
    : `huawei-${Date.now()}`;

  // Determine isDefault: true if this is the first account for the user,
  // or if this account already exists and was previously the default
  const existingAccounts = listProviderAccounts(flow.userId);
  const existingEntry = existingAccounts.find((a) => a.id === accountId);
  const isFirstAccount = existingAccounts.length === 0;
  const isDefault = isFirstAccount || (existingEntry?.isDefault ?? false);

  upsertProviderAccount({
    id: accountId,
    userId: flow.userId,
    provider: "huawei-codearts",
    providerUserId: result.userId,
    providerUserName: result.userName,
    domainId: result.domainId,
    displayName:
      result.userName ?? `Huawei ${result.domainId?.slice(0, 8) ?? "Account"}`,
    isDefault,
    status: "active",
  });

  storeSession(accountId, {
    providerAccountId: accountId,
    businessToken: result.businessToken,
    accessKey: result.credentials.accessKey,
    secretKeyCiphertext: result.credentials.secretKey
      ? encryptString(result.credentials.secretKey)
      : undefined,
    securityToken: result.credentials.securityToken,
    expiresAt: result.credentials.expiresAt,
  });

  // Issue a dedicated API key for this account
  const rawKey = `sk-${randomUUID()}`;
  issueApiKey({
    userId: flow.userId,
    providerAccountId: accountId,
    name:
      result.userName ?? `huawei-${result.domainId?.slice(0, 8) ?? "account"}`,
    rawKey,
  });

  console.log(
    `[huawei-auth] login session stored providerAccountId=${accountId} userId=${result.userId ?? "missing"} userName=${result.userName ?? "missing"} domainId=${result.domainId ?? "missing"} businessToken=${maskValue(result.businessToken)} accessKey=${maskValue(result.credentials.accessKey)} securityToken=${maskValue(result.credentials.securityToken)} expiresAt=${result.credentials.expiresAt ?? "missing"}`,
  );

  return { accountId, apiKey: rawKey };
}

async function waitForFlowAuthentication(flow: {
  ticketId: string;
  state: string;
  expiresAt: number;
  userId: string;
  identifier?: string;
  redirect?: string;
}): Promise<{ accountId: string; apiKey: string }> {
  console.log(
    `[huawei-auth] start waiting flow authentication ticketId=${maskValue(flow.ticketId)} userId=${flow.userId}`,
  );
  const identifier = await waitForFlowIdentifier(flow.ticketId);
  const result = await waitForHuaweiTicketExchange({
    ticketId: flow.ticketId,
    identifier,
  });

  return completeLoginFlow(flow, result);
}

export function initiateHuaweiLogin(req: Request, res: Response): void {
  const auth = getRequestAuth(req);
  const callbackPort = Number(req.query.callback_port) || config.callbackPort;
  const flow = createHuaweiLoginFlow(callbackPort);

  loginFlows.set(flow.ticketId, {
    ticketId: flow.ticketId,
    state: flow.state,
    expiresAt: flow.expiresAt.getTime(),
    userId: auth.userId,
  });

  console.log(
    `[${getTraceId(req)}] Created Huawei login flow for user ${auth.userId}`,
  );

  res.json({
    login_url: flow.loginUrl,
    authorize_url: `${getCallbackHost(req)}/auth/huawei/authorize`,
    state: flow.state,
    ticket_id: flow.ticketId,
    expires_at: flow.expiresAt.toISOString(),
  });
}

export function authorizeHuaweiLogin(req: Request, res: Response): void {
  const defaultUser = getDefaultUser();
  if (!defaultUser) {
    res.status(500).json(createOpenAIError("No default user configured"));
    return;
  }

  const callbackPort = Number(req.query.callback_port) || config.callbackPort;
  // Only clear expired flows, not all pending flows (multi-account support)
  const now = Date.now();
  for (const [ticketId, pendingFlow] of loginFlows.entries()) {
    if (pendingFlow.expiresAt <= now) {
      loginFlows.delete(ticketId);
      if (latestBrowserFlowTicketId === ticketId) {
        latestBrowserFlowTicketId = null;
      }
    }
  }
  const flow = createHuaweiLoginFlow(callbackPort);
  loginFlows.set(flow.ticketId, {
    ticketId: flow.ticketId,
    state: flow.state,
    expiresAt: flow.expiresAt.getTime(),
    userId: defaultUser.id,
  });
  latestBrowserFlowTicketId = flow.ticketId;

  console.log(
    `[huawei-auth] browser authorize start ticketId=${maskValue(flow.ticketId)} callbackPort=${callbackPort} loginUrl=${flow.loginUrl}`,
  );

  void waitForFlowAuthentication({
    ticketId: flow.ticketId,
    state: flow.state,
    expiresAt: flow.expiresAt.getTime(),
    userId: defaultUser.id,
  }).catch((error) => {
    console.error("Huawei browser login flow failed:", error);
    const pendingFlow = loginFlows.get(flow.ticketId);
    if (pendingFlow) {
      loginFlows.delete(flow.ticketId);
    }
    if (latestBrowserFlowTicketId === flow.ticketId) {
      latestBrowserFlowTicketId = null;
    }
  });

  res.redirect(flow.loginUrl);
}

export async function handleHuaweiCallback(
  req: Request,
  res: Response,
): Promise<void> {
  const identifier = req.query.identifier;
  const redirect =
    typeof req.query.redirect === "string" ? req.query.redirect : undefined;

  if (!identifier || typeof identifier !== "string") {
    res.status(400).json(createOpenAIError("Missing identifier in callback"));
    return;
  }

  const flow = getPendingLoginFlow();
  if (!flow) {
    res.status(400).json(createOpenAIError("Unknown or expired login flow"));
    return;
  }

  if (Date.now() > flow.expiresAt) {
    loginFlows.delete(flow.ticketId);
    res.status(400).json(createOpenAIError("Login flow expired"));
    return;
  }

  console.log(
    `[huawei-auth] callback received ticketId=${maskValue(flow.ticketId)} identifier=${maskValue(identifier)} redirect=${redirect ?? "missing"}`,
  );

  loginFlows.set(flow.ticketId, {
    ...flow,
    identifier,
    redirect,
  });

  if (redirect) {
    res.redirect(307, redirect);
    return;
  }

  // Wait for authentication to complete
  try {
    const { accountId, apiKey } = await waitForFlowAuthentication(flow);

    // Set auth_key cookie with the new account's dedicated API key
    const isProduction = process.env.NODE_ENV === "production";
    res.cookie("auth_key", apiKey, {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });

    console.log(
      `[huawei-auth] login complete, redirecting to /success userId=${flow.userId} accountId=${accountId}`,
    );

    res.redirect("/success");
  } catch (error) {
    console.error("[huawei-auth] callback authentication failed:", error);
    res.status(500).json(createOpenAIError("Authentication failed"));
  }
}
