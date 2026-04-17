import type { Request, Response } from "express";
import { encryptString } from "../auth/crypto/encryption";
import { createHuaweiLoginFlow } from "../auth/huawei/login-flow";
import { storeSession } from "../auth/huawei/session-store";
import { config } from "../config";
import { getRequestAuth } from "../middleware/authenticate-api-key";
import { getTraceId } from "../middleware/request-context";
import { getDefaultUser, upsertProviderAccount } from "../auth/store";
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

function resetPendingLoginFlows(): void {
  loginFlows.clear();
  latestBrowserFlowTicketId = null;
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
): void {
  loginFlows.delete(flow.ticketId);
  if (latestBrowserFlowTicketId === flow.ticketId) {
    latestBrowserFlowTicketId = null;
  }

  upsertProviderAccount({
    id: "default",
    userId: flow.userId,
    provider: "huawei-codearts",
    providerUserId: result.userId,
    providerUserName: result.userName,
    domainId: result.domainId,
    displayName: result.userName ?? "Default Huawei Account",
    isDefault: true,
    status: "active",
  });

  storeSession("default", {
    providerAccountId: "default",
    businessToken: result.businessToken,
    accessKey: result.credentials.accessKey,
    secretKeyCiphertext: result.credentials.secretKey
      ? encryptString(result.credentials.secretKey)
      : undefined,
    securityToken: result.credentials.securityToken,
    expiresAt: result.credentials.expiresAt,
  });

  console.log(
    `[huawei-auth] login session stored providerAccountId=default userId=${result.userId ?? "missing"} userName=${result.userName ?? "missing"} domainId=${result.domainId ?? "missing"} businessToken=${maskValue(result.businessToken)} accessKey=${maskValue(result.credentials.accessKey)} securityToken=${maskValue(result.credentials.securityToken)} expiresAt=${result.credentials.expiresAt ?? "missing"}`,
  );
}

async function waitForFlowAuthentication(flow: {
  ticketId: string;
  state: string;
  expiresAt: number;
  userId: string;
  identifier?: string;
  redirect?: string;
}): Promise<HuaweiTicketExchangeResponse> {
  console.log(
    `[huawei-auth] start waiting flow authentication ticketId=${maskValue(flow.ticketId)} userId=${flow.userId}`,
  );
  const identifier = await waitForFlowIdentifier(flow.ticketId);
  const result = await waitForHuaweiTicketExchange({
    ticketId: flow.ticketId,
    identifier,
  });

  completeLoginFlow(flow, result);
  return result;
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
  resetPendingLoginFlows();
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

export function handleHuaweiCallback(req: Request, res: Response): void {
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

  res.json({ success: true });
}
