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
  validateApiKey,
  upsertProviderAccount,
  listProviderAccounts,
  issueApiKey,
} from "../auth/store";
import {
  waitForHuaweiTicketExchange,
  type HuaweiTicketExchangeResponse,
} from "../upstream/huawei/ticket";
import { createOpenAIError } from "../utils/openai-error";

let exchangeHuaweiTicket = waitForHuaweiTicketExchange;

type BrowserLoginStatus =
  | "pending"
  | "callback_received"
  | "exchanging"
  | "completed"
  | "failed"
  | "expired";

interface LoginFlowRecord {
  ticketId: string;
  loginUrl?: string;
  state: string;
  expiresAt: number;
  userId: string;
  kind: "api" | "browser";
  identifier?: string;
  redirect?: string;
  browserStatus?: BrowserLoginStatus;
  error?: string;
  completedAt?: number;
  accountId?: string;
  apiKeyId?: string;
  apiKey?: string;
}

const BROWSER_FLOW_MAX_AGE_MS = 5 * 60 * 1000;
const TERMINAL_BROWSER_FLOW_RETENTION_MS = 10 * 60 * 1000;

const loginFlows = new Map<
  string,
  LoginFlowRecord
>();
const browserExchangeTasks = new Map<string, Promise<void>>();

function maskValue(value: string | undefined): string {
  if (!value) {
    return "missing";
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}***`;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function isTerminalBrowserStatus(status: BrowserLoginStatus | undefined): boolean {
  return status === "completed" || status === "failed" || status === "expired";
}

function clearExpiredLoginFlows(now = Date.now()): void {
  for (const [ticketId, flow] of loginFlows.entries()) {
    if (flow.kind === "browser") {
      if (
        isTerminalBrowserStatus(flow.browserStatus) &&
        flow.completedAt &&
        now - flow.completedAt > TERMINAL_BROWSER_FLOW_RETENTION_MS
      ) {
        loginFlows.delete(ticketId);
        continue;
      }

      if (!isTerminalBrowserStatus(flow.browserStatus) && now > flow.expiresAt) {
        loginFlows.set(ticketId, {
          ...flow,
          browserStatus: "expired",
          error: flow.error ?? "Login flow expired",
          completedAt: now,
        });
      }
      continue;
    }

    if (now > flow.expiresAt) {
      loginFlows.delete(ticketId);
    }
  }
}

function getBrowserLoginFlow(ticketId: string): LoginFlowRecord | null {
  clearExpiredLoginFlows();
  const flow = loginFlows.get(ticketId);
  if (!flow || flow.kind !== "browser") {
    return null;
  }
  return flow;
}

function getPendingApiLoginFlow(ticketId?: string): LoginFlowRecord | null {
  clearExpiredLoginFlows();

  if (ticketId) {
    const exact = loginFlows.get(ticketId);
    if (exact && exact.kind === "api") {
      return exact;
    }
  }

  const pending = Array.from(loginFlows.values())
    .filter((flow) => flow.kind === "api" && flow.expiresAt > Date.now())
    .sort((left, right) => right.expiresAt - left.expiresAt);

  return pending[0] ?? null;
}

function getBrowserLoginStatus(flow: LoginFlowRecord): {
  ticket_id: string;
  status: BrowserLoginStatus;
  expires_at: string;
  completed_at: string | null;
  error?: string;
  account_id?: string;
} {
  return {
    ticket_id: flow.ticketId,
    status: flow.browserStatus ?? "pending",
    expires_at: new Date(flow.expiresAt).toISOString(),
    completed_at: flow.completedAt
      ? new Date(flow.completedAt).toISOString()
      : null,
    error: flow.error,
    account_id: flow.accountId,
  };
}

function getCallbackHost(req: Request): string {
  return `${req.protocol}://${req.get("host") ?? `127.0.0.1:${config.port}`}`;
}

function setAuthKeyCookie(res: Response, apiKey: string): void {
  const isProduction = process.env.NODE_ENV === "production";
  res.cookie("auth_key", apiKey, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function setAuthKeyIdCookie(res: Response, apiKeyId: string): void {
  const isProduction = process.env.NODE_ENV === "production";
  res.cookie("auth_key_id", apiKeyId, {
    httpOnly: false,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function setBrowserLoginTicketCookie(res: Response, ticketId: string): void {
  const isProduction = process.env.NODE_ENV === "production";
  res.cookie("huawei_login_ticket", ticketId, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: BROWSER_FLOW_MAX_AGE_MS,
  });
}

function clearBrowserLoginTicketCookie(res: Response): void {
  const isProduction = process.env.NODE_ENV === "production";
  res.clearCookie("huawei_login_ticket", {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
  });
}

function resolveBrowserLoginUserId(req: Request): string | null {
  const cookieApiKey =
    typeof req.cookies.auth_key === "string" ? req.cookies.auth_key : undefined;
  if (cookieApiKey) {
    const auth = validateApiKey(cookieApiKey);
    if (auth) {
      return auth.userId;
    }
  }

  return getDefaultUser()?.id ?? null;
}

function createBrowserLoginFlow(userId: string, callbackPort: number): LoginFlowRecord {
  const flow = createHuaweiLoginFlow(callbackPort);
  const record: LoginFlowRecord = {
    ticketId: flow.ticketId,
    loginUrl: flow.loginUrl,
    state: flow.state,
    expiresAt: flow.expiresAt.getTime(),
    userId,
    kind: "browser",
    browserStatus: "pending",
  };
  loginFlows.set(flow.ticketId, record);
  return record;
}

function provisionLoginResult(
  flow: LoginFlowRecord,
  result: HuaweiTicketExchangeResponse,
): { accountId: string; apiKeyId: string; apiKey: string } {
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

  // Issue a dedicated API key for this account (Key↔Session 1:1)
  const rawKey = `sk-${randomUUID()}`;
  const apiKeyObj = issueApiKey({
    userId: flow.userId,
    providerAccountId: accountId,
    name:
      result.userName ?? `huawei-${result.domainId?.slice(0, 8) ?? "account"}`,
    rawKey,
  });

  // Store session bound to this key (1:1)
  storeSession(apiKeyObj.id, {
    keyId: apiKeyObj.id,
    providerAccountId: accountId,
    businessToken: result.businessToken,
    accessKey: result.credentials.accessKey,
    secretKeyCiphertext: result.credentials.secretKey
      ? encryptString(result.credentials.secretKey)
      : undefined,
    securityToken: result.credentials.securityToken,
    expiresAt: result.credentials.expiresAt,
  });

  console.log(
    `[huawei-auth] login session stored providerAccountId=${accountId} userId=${result.userId ?? "missing"} userName=${result.userName ?? "missing"} domainId=${result.domainId ?? "missing"} businessToken=${maskValue(result.businessToken)} accessKey=${maskValue(result.credentials.accessKey)} securityToken=${maskValue(result.credentials.securityToken)} expiresAt=${result.credentials.expiresAt ?? "missing"}`,
  );

  return { accountId, apiKeyId: apiKeyObj.id, apiKey: rawKey };
}

function startBrowserFlowExchange(
  flow: LoginFlowRecord,
  identifier: string,
  redirect: string | undefined,
): void {
  if (browserExchangeTasks.has(flow.ticketId)) {
    return;
  }

  loginFlows.set(flow.ticketId, {
    ...flow,
    identifier,
    redirect,
    browserStatus: "callback_received",
    error: undefined,
  });

  const task = (async () => {
    loginFlows.set(flow.ticketId, {
      ...flow,
      identifier,
      redirect,
      browserStatus: "exchanging",
      error: undefined,
    });

    try {
      const result = await exchangeHuaweiTicket({
        ticketId: flow.ticketId,
        identifier,
      });
      const currentFlow = getBrowserLoginFlow(flow.ticketId) ?? {
        ...flow,
        identifier,
        redirect,
      };
      const { accountId, apiKeyId, apiKey } = provisionLoginResult(currentFlow, result);

      loginFlows.set(flow.ticketId, {
        ...currentFlow,
        identifier,
        redirect,
        browserStatus: "completed",
        completedAt: Date.now(),
        error: undefined,
        accountId,
        apiKeyId,
        apiKey,
      });
    } catch (error) {
      console.error("[huawei-auth] background authentication failed:", error);
      const currentFlow = getBrowserLoginFlow(flow.ticketId) ?? flow;
      loginFlows.set(flow.ticketId, {
        ...currentFlow,
        identifier,
        redirect,
        browserStatus: "failed",
        completedAt: Date.now(),
        error:
          error instanceof Error ? error.message : "Authentication failed",
      });
    } finally {
      browserExchangeTasks.delete(flow.ticketId);
    }
  })();

  browserExchangeTasks.set(flow.ticketId, task);
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
    kind: "api",
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
  clearExpiredLoginFlows();

  const userId = resolveBrowserLoginUserId(req);
  if (!userId) {
    res.status(500).json(createOpenAIError("No default user configured"));
    return;
  }

  const callbackPort = Number(req.query.callback_port) || config.callbackPort;
  const flow = createBrowserLoginFlow(userId, callbackPort);
  setBrowserLoginTicketCookie(res, flow.ticketId);

  console.log(
    `[huawei-auth] browser authorize start ticketId=${maskValue(flow.ticketId)} callbackPort=${callbackPort}`,
  );

  res.redirect(flow.loginUrl ?? "/");
}

export function startBrowserHuaweiLogin(req: Request, res: Response): void {
  clearExpiredLoginFlows();

  const userId = resolveBrowserLoginUserId(req);
  if (!userId) {
    res.status(500).json(createOpenAIError("No default user configured"));
    return;
  }

  const callbackPort = Number(req.query.callback_port) || config.callbackPort;
  const flow = createBrowserLoginFlow(userId, callbackPort);
  setBrowserLoginTicketCookie(res, flow.ticketId);

  res.json({
    ticket_id: flow.ticketId,
    login_url: flow.loginUrl,
    expires_at: new Date(flow.expiresAt).toISOString(),
    status_url: `${getCallbackHost(req)}/auth/huawei/browser/status/${flow.ticketId}`,
  });
}

export function getBrowserHuaweiLoginStatus(req: Request, res: Response): void {
  const flow = getBrowserLoginFlow(req.params.ticketId);
  if (!flow) {
    res.status(404).json({ error: "Login ticket not found" });
    return;
  }

  res.json(getBrowserLoginStatus(flow));
}


export function finalizeBrowserHuaweiLogin(req: Request, res: Response): void {
  const flow = getBrowserLoginFlow(req.params.ticketId);
  if (!flow) {
    res.status(404).json({ error: "Login ticket not found" });
    return;
  }

  if (flow.browserStatus !== "completed" || !flow.apiKey) {
    res.status(409).json({
      error: flow.error ?? `Login ticket is not ready: ${flow.browserStatus}`,
      status: flow.browserStatus ?? "pending",
    });
    return;
  }

  clearBrowserLoginTicketCookie(res);
  setAuthKeyCookie(res, flow.apiKey);
  if (flow.apiKeyId) {
    setAuthKeyIdCookie(res, flow.apiKeyId);
  }
  const redirectUrl = flow.apiKeyId
    ? `/success?keyId=${encodeURIComponent(flow.apiKeyId)}`
    : "/success";
  res.json({ success: true, redirect_url: redirectUrl });
}

export async function handleHuaweiCallback(
  req: Request,
  res: Response,
): Promise<void> {
  clearExpiredLoginFlows();

  const identifier = req.query.identifier;
  const redirect =
    typeof req.query.redirect === "string" ? req.query.redirect : undefined;
  const preferredTicketId =
    typeof req.query.ticket_id === "string"
      ? req.query.ticket_id
      : typeof req.cookies.huawei_login_ticket === "string"
        ? req.cookies.huawei_login_ticket
        : undefined;

  if (!identifier || typeof identifier !== "string") {
    res.status(400).json(createOpenAIError("Missing identifier in callback"));
    return;
  }

  const browserFlow = preferredTicketId
    ? getBrowserLoginFlow(preferredTicketId)
    : null;

  if (browserFlow) {
    if (Date.now() > browserFlow.expiresAt) {
      loginFlows.set(browserFlow.ticketId, {
        ...browserFlow,
        browserStatus: "expired",
        error: "Login flow expired",
        completedAt: Date.now(),
      });
      res.redirect(
        `/auth/huawei/browser/complete?ticket_id=${encodeURIComponent(browserFlow.ticketId)}`,
      );
      return;
    }

    console.log(
      `[huawei-auth] callback received ticketId=${maskValue(browserFlow.ticketId)} identifier=${maskValue(identifier)} redirect=${redirect ?? "missing"}`,
    );

    startBrowserFlowExchange(browserFlow, identifier, redirect);
    if (redirect) {
      res.redirect(307, redirect);
      return;
    }

    res.redirect(
      `/auth/huawei/browser/complete?ticket_id=${encodeURIComponent(browserFlow.ticketId)}`,
    );
    return;
  }

  if (!preferredTicketId) {
    console.warn(
      `[huawei-auth] callback received without correlated ticket identifier=${maskValue(identifier)} redirect=${redirect ?? "missing"}`,
    );
  } else if (!browserFlow) {
    console.warn(
      `[huawei-auth] callback ticket not found or not browser ticketId=${maskValue(preferredTicketId)} identifier=${maskValue(identifier)}`,
    );
  }

  const apiFlow = getPendingApiLoginFlow(preferredTicketId);
  if (!apiFlow) {
    res.status(400).json(createOpenAIError("Unknown or expired login flow"));
    return;
  }

  console.log(
    `[huawei-auth] callback received api ticketId=${maskValue(apiFlow.ticketId)} identifier=${maskValue(identifier)} redirect=${redirect ?? "missing"}`,
  );

  loginFlows.set(apiFlow.ticketId, {
    ...apiFlow,
    identifier,
    redirect,
  });

  if (redirect) {
    res.redirect(307, redirect);
    return;
  }

  res.json({ success: true, ticket_id: apiFlow.ticketId });
}

export const __testHooks = {
  resetLoginFlows(): void {
    loginFlows.clear();
    browserExchangeTasks.clear();
  },
  getLoginFlow(ticketId: string): LoginFlowRecord | undefined {
    return loginFlows.get(ticketId);
  },
  setLoginFlow(flow: LoginFlowRecord): void {
    loginFlows.set(flow.ticketId, flow);
  },
  setExchangeHuaweiTicketForTest(
    implementation: typeof waitForHuaweiTicketExchange,
  ): void {
    exchangeHuaweiTicket = implementation;
  },
  resetExchangeHuaweiTicketForTest(): void {
    exchangeHuaweiTicket = waitForHuaweiTicketExchange;
  },
  async waitForBrowserExchangeTask(ticketId: string): Promise<void> {
    await browserExchangeTasks.get(ticketId);
  },
};
