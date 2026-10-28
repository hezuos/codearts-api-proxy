import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { encryptString, tryDecryptString } from "../auth/crypto/encryption";
import { createHuaweiLoginFlow, type PKCEPair } from "../auth/huawei/login-flow";
import { storeSession } from "../auth/huawei/session-store";
import { scheduleSessionRefresh } from "../auth/huawei/refresh-task";
import { config, isProduction, redirectAllowedHosts } from "../config";
import { getRequestAuth } from "../middleware/authenticate-api-key";
import { getTraceId } from "../middleware/request-context";
import { logger } from "../utils/logger";
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
import { maskValue } from "../utils/mask";
import { isNewIamLoginPayload, extractNewIamCredentials, extractRefreshToken } from "../upstream/huawei/extract-credentials";
import { resolveUserInfo } from "../upstream/huawei/user-info";
import { getTokenByAuthorizationCode } from "../auth/huawei/token-exchange";
import type { DpopKeyPair } from "../auth/huawei/dpop";

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
  /** PKCE 密钥对（新版登录流程使用） */
  pkcePair?: PKCEPair;
  /** DPoP 密钥对（OAuth2 token exchange 使用） */
  dpopKeyPair?: DpopKeyPair;
}

const BROWSER_FLOW_MAX_AGE_MS = 5 * 60 * 1000;
const TERMINAL_BROWSER_FLOW_RETENTION_MS = 10 * 60 * 1000;

const loginFlows = new Map<
  string,
  LoginFlowRecord
>();
const browserExchangeTasks = new Map<string, Promise<void>>();

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

/**
 * 获取任何类型的 pending 登录流程（API 或 browser）。
 * 用于 OAuth2 回调处理，因为 UI 使用 browser 流程。
 */
function getAnyPendingLoginFlow(): LoginFlowRecord | null {
  clearExpiredLoginFlows();

  const pending = Array.from(loginFlows.values())
    .filter((flow) => flow.expiresAt > Date.now())
    .sort((left, right) => right.expiresAt - left.expiresAt);

  return pending[0] ?? null;
}

/**
 * 处理 OAuth2 授权码回调。
 *
 * 逆向自上游 LoginBackend.getTokenByAuthorizationCode()：
 * 使用授权码 + code_verifier + DPoP 换取 token
 */
async function handleOAuth2AuthorizationCode(
  flow: LoginFlowRecord,
  code: string,
  res: Response,
): Promise<void> {
  try {
    logger.info(
      `[huawei-auth] Processing OAuth2 authorization code for flow ticketId=${maskValue(flow.ticketId)}`,
    );

    // 验证必要的参数
    if (!flow.pkcePair?.codeVerifier) {
      throw new Error("Missing PKCE code_verifier in login flow");
    }
    if (!flow.dpopKeyPair) {
      throw new Error("Missing DPoP key pair in login flow");
    }

    // 调用 OAuth2 token exchange
    const tokenResponse = await getTokenByAuthorizationCode({
      code,
      codeVerifier: flow.pkcePair.codeVerifier,
      port: config.callbackPort,
      dpopKeyPair: flow.dpopKeyPair,
    });

    if (!tokenResponse.credentials) {
      throw new Error("Token response missing credentials");
    }

    // 提取凭证
    const { credentials, refresh_token } = tokenResponse;

    // 获取用户信息（通过 IAM API）
    const userInfo = await resolveUserInfo({
      accessKey: credentials.access_key_id,
      secretKey: credentials.secret_access_key,
      securityToken: credentials.security_token,
    }, refresh_token);

    // 生成账号 ID
    const accountId = userInfo.domainId
      ? `huawei-${userInfo.domainId}`
      : `huawei-${Date.now()}`;

    // 确定是否为默认账号
    const existingAccounts = listProviderAccounts(flow.userId);
    const existingEntry = existingAccounts.find((a) => a.id === accountId);
    const isFirstAccount = existingAccounts.length === 0;
    const isDefault = isFirstAccount || (existingEntry?.isDefault ?? false);

    // 创建/更新 Provider Account
    upsertProviderAccount({
      id: accountId,
      userId: flow.userId,
      provider: "huawei-codearts",
      providerUserId: userInfo.userId,
      providerUserName: userInfo.userName,
      domainId: userInfo.domainId,
      displayName: userInfo.userName ?? `Huawei ${userInfo.domainId?.slice(0, 8) ?? "Account"}`,
      isDefault,
      status: "active",
    });

    // 生成 API Key
    const rawKey = `sk-${randomUUID()}`;
    const apiKeyObj = issueApiKey({
      userId: flow.userId,
      providerAccountId: accountId,
      name: userInfo.userName ?? `huawei-${userInfo.domainId?.slice(0, 8) ?? "account"}`,
      rawKey,
    });

    // 存储 Session（包含 DPoP 和 PKCE 信息，用于 refresh）
    storeSession(apiKeyObj.id, {
      keyId: apiKeyObj.id,
      providerAccountId: accountId,
      accessKey: credentials.access_key_id,
      secretKeyCiphertext: credentials.secret_access_key
        ? encryptString(credentials.secret_access_key)
        : undefined,
      securityToken: credentials.security_token,
      expiresAt: credentials.expiration,
      refreshToken: refresh_token,
      credentialFormat: "new_iam",
      dpopKeyPair: flow.dpopKeyPair,
      pkceCodeVerifier: flow.pkcePair.codeVerifier,
    });

    // 启动动态刷新调度
    scheduleSessionRefresh(apiKeyObj.id);

    logger.info(
      `[huawei-auth] OAuth2 login successful accountId=${accountId} userId=${userInfo.userId} userName=${userInfo.userName}`,
    );

    // 如果是浏览器登录流程，更新状态为 completed
    if (flow.kind === "browser") {
      loginFlows.set(flow.ticketId, {
        ...flow,
        browserStatus: "completed",
        completedAt: Date.now(),
        error: undefined,
        accountId,
        apiKeyId: apiKeyObj.id,
        apiKey: rawKey,
      });
      logger.info(
        `[huawei-auth] Browser login flow updated to completed ticketId=${maskValue(flow.ticketId)}`,
      );
    }

    // 返回成功
    res.json({
      success: true,
      account_id: accountId,
      api_key_id: apiKeyObj.id,
      user_id: userInfo.userId,
      user_name: userInfo.userName,
    });
  } catch (error) {
    logger.error("[huawei-auth] OAuth2 authorization code processing failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    // 如果是浏览器登录流程，更新状态为 failed
    if (flow.kind === "browser") {
      loginFlows.set(flow.ticketId, {
        ...flow,
        browserStatus: "failed",
        completedAt: Date.now(),
        error: error instanceof Error ? error.message : "OAuth2 processing failed",
      });
    }

    res.status(500).json(createOpenAIError(
      error instanceof Error ? error.message : "OAuth2 processing failed"
    ));
  }
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

/**
 * 校验回调 `redirect` 参数（开放重定向防护，CWE-601）。
 * 仅放行：
 *   - 同源相对路径（单个 "/" 开头，拒绝 "//host" 协议相对写法）
 *   - 白名单主机上的绝对 http(s) URL（华为云重定向主机 + 本地回环 + 环境变量扩展）
 * 不合规时返回 undefined，调用方回退到本地完成页。
 */
function resolveSafeRedirect(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const trimmed = target.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.startsWith("/\\")) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      redirectAllowedHosts.has(url.hostname.toLowerCase())
    ) {
      // 从已校验的 URL 对象重新序列化，而非回传原始用户输入——
      // 断开污点流，使 CodeQL 能识别此值已被净化（CWE-601）。
      return url.origin + url.pathname + url.search + url.hash;
    }
  } catch {
    // 非法 URL —— 按不安全处理
  }
  logger.warn("[huawei-auth] rejected unsafe redirect target", {
    redirect: maskValue(trimmed),
  });
  return undefined;
}

function setAuthKeyCookie(res: Response, apiKey: string): void {
  // AES-256-GCM 加密后写入，避免明文 API Key 落在 cookie（CWE-312）；读取侧见 requireUiAuth。
  res.cookie("auth_key", encryptString(apiKey), {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function setAuthKeyIdCookie(res: Response, apiKeyId: string): void {
  // 同 auth_key：keyId 一并加密，保持 cookie 形态统一。
  res.cookie("auth_key_id", encryptString(apiKeyId), {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function setBrowserLoginTicketCookie(res: Response, ticketId: string): void {
  res.cookie("huawei_login_ticket", ticketId, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: BROWSER_FLOW_MAX_AGE_MS,
  });
}

function clearBrowserLoginTicketCookie(res: Response): void {
  res.clearCookie("huawei_login_ticket", {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
  });
}

function resolveBrowserLoginUserId(req: Request): string | null {
  // cookie 中的 API Key 为 AES-256-GCM 密文，需先解开再校验。
  const cookieApiKey = tryDecryptString(
    typeof req.cookies.auth_key === "string" ? req.cookies.auth_key : undefined,
  );
  if (cookieApiKey) {
    const auth = validateApiKey(cookieApiKey);
    if (auth) {
      return auth.userId;
    }
  }

  return getDefaultUser()?.id ?? null;
}

async function createBrowserLoginFlow(userId: string, callbackPort: number): Promise<LoginFlowRecord> {
  const flow = await createHuaweiLoginFlow(callbackPort);
  const record: LoginFlowRecord = {
    ticketId: flow.ticketId,
    loginUrl: flow.loginUrl,
    state: flow.state,
    expiresAt: flow.expiresAt.getTime(),
    userId,
    kind: "browser",
    browserStatus: "pending",
    pkcePair: flow.pkcePair,
    dpopKeyPair: flow.dpopKeyPair,
  };
  loginFlows.set(flow.ticketId, record);
  return record;
}

async function provisionLoginResult(
  flow: LoginFlowRecord,
  result: HuaweiTicketExchangeResponse,
): Promise<{ accountId: string; apiKeyId: string; apiKey: string }> {
  const rawPayload = result.raw as Record<string, unknown>;

  // v5.0.2: 检测新版 IAM 登录格式，分派到不同处理函数
  if (isNewIamLoginPayload(rawPayload)) {
    return await provisionNewIamLoginResult(flow, rawPayload);
  }

  // 旧格式（legacy）走现有逻辑
  return provisionLegacyLoginResult(flow, result);
}

/** 新版 IAM 登录格式处理（v5.0.2） */
async function provisionNewIamLoginResult(
  flow: LoginFlowRecord,
  payload: import("../upstream/huawei/extract-credentials").NewIamLoginPayload,
): Promise<{ accountId: string; apiKeyId: string; apiKey: string }> {
  // 提取凭证
  const creds = extractNewIamCredentials(payload);

  // 提取 refresh_token
  const refreshToken = extractRefreshToken(payload);

  // 提取用户信息（优先从 payload 中提取，缺失则调用 IAM API）
  let userId = payload.user_id;
  let userName = payload.user_name;
  let domainId = payload.domain_id;

  if (!userId || !userName) {
    // 调用 IAM API 获取用户信息
    logger.info(
      `[huawei-auth] NewIamLogin: user info missing from payload, calling resolveUserInfo`,
    );
    const userInfo = await resolveUserInfo({
      accessKey: creds.accessKey,
      secretKey: creds.secretKey,
      securityToken: creds.securityToken,
    }, refreshToken);
    userId = userInfo.userId;
    userName = userInfo.userName;
    domainId = userInfo.domainId;
  }

  // Use domainId to generate a unique, stable accountId for each Huawei account
  const accountId = domainId
    ? `huawei-${domainId}`
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
    providerUserId: userId,
    providerUserName: userName,
    domainId,
    displayName:
      userName ?? `Huawei ${domainId?.slice(0, 8) ?? "Account"}`,
    isDefault,
    status: "active",
  });

  // Issue a dedicated API key for this account (Key↔Session 1:1)
  const rawKey = `sk-${randomUUID()}`;
  const apiKeyObj = issueApiKey({
    userId: flow.userId,
    providerAccountId: accountId,
    name:
      userName ?? `huawei-${domainId?.slice(0, 8) ?? "account"}`,
    rawKey,
  });

  // Store session bound to this key (1:1) — v5.0.2 新增字段
  storeSession(apiKeyObj.id, {
    keyId: apiKeyObj.id,
    providerAccountId: accountId,
    accessKey: creds.accessKey,
    secretKeyCiphertext: creds.secretKey
      ? encryptString(creds.secretKey)
      : undefined,
    securityToken: creds.securityToken,
    expiresAt: creds.expiresAt,
    refreshToken,
    credentialFormat: "new_iam",
  });

  logger.info(
    `[huawei-auth] NewIamLogin session stored providerAccountId=${accountId} userId=${userId} userName=${userName} domainId=${domainId ?? "missing"} credentialFormat=new_iam`,
  );

  // 启动动态刷新调度
  scheduleSessionRefresh(apiKeyObj.id);

  return { accountId, apiKeyId: apiKeyObj.id, apiKey: rawKey };
}

/** 旧格式（legacy）登录处理 — 现有逻辑保持不变 */
function provisionLegacyLoginResult(
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
    credentialFormat: "legacy",
  });

  logger.info(
    `[huawei-auth] login session stored providerAccountId=${accountId} userId=${result.userId ?? "missing"} userName=${result.userName ?? "missing"} domainId=${result.domainId ?? "missing"} businessToken=${maskValue(result.businessToken)} accessKey=${maskValue(result.credentials.accessKey)} securityToken=${maskValue(result.credentials.securityToken)} expiresAt=${result.credentials.expiresAt ?? "missing"}`,
  );

  // 启动动态刷新调度
  scheduleSessionRefresh(apiKeyObj.id);

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
      const { accountId, apiKeyId, apiKey } = await provisionLoginResult(currentFlow, result);

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
      logger.error("[huawei-auth] background authentication failed", { error: error instanceof Error ? error.message : String(error) });
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

export async function initiateHuaweiLogin(req: Request, res: Response): Promise<void> {
  const auth = getRequestAuth(req);
  const callbackPort = Number(req.query.callback_port) || config.callbackPort;
  const flow = await createHuaweiLoginFlow(callbackPort);

  loginFlows.set(flow.ticketId, {
    ticketId: flow.ticketId,
    state: flow.state,
    expiresAt: flow.expiresAt.getTime(),
    userId: auth.userId,
    kind: "api",
    pkcePair: flow.pkcePair,
    dpopKeyPair: flow.dpopKeyPair,
  });

  logger.info(
    `[${getTraceId(req)}] Created Huawei login flow for user ${auth.userId}, ticketId=${maskValue(flow.ticketId)}, expiresAt=${flow.expiresAt.toISOString()}, totalFlows=${loginFlows.size}`,
  );

  res.json({
    login_url: flow.loginUrl,
    authorize_url: `${getCallbackHost(req)}/auth/huawei/authorize`,
    state: flow.state,
    ticket_id: flow.ticketId,
    expires_at: flow.expiresAt.toISOString(),
  });
}

export async function authorizeHuaweiLogin(req: Request, res: Response): Promise<void> {
  clearExpiredLoginFlows();

  const userId = resolveBrowserLoginUserId(req);
  if (!userId) {
    res.status(500).json(createOpenAIError("No default user configured"));
    return;
  }

  const callbackPort = Number(req.query.callback_port) || config.callbackPort;
  const flow = await createBrowserLoginFlow(userId, callbackPort);
  setBrowserLoginTicketCookie(res, flow.ticketId);

  logger.info(
    `[huawei-auth] browser authorize start ticketId=${maskValue(flow.ticketId)} callbackPort=${callbackPort}`,
  );

  res.redirect(flow.loginUrl ?? "/");
}

export async function startBrowserHuaweiLogin(req: Request, res: Response): Promise<void> {
  clearExpiredLoginFlows();

  const userId = resolveBrowserLoginUserId(req);
  if (!userId) {
    res.status(500).json(createOpenAIError("No default user configured"));
    return;
  }

  const callbackPort = Number(req.query.callback_port) || config.callbackPort;
  const flow = await createBrowserLoginFlow(userId, callbackPort);
  setBrowserLoginTicketCookie(res, flow.ticketId);

  res.json({
    ticket_id: flow.ticketId,
    login_url: flow.loginUrl,
    expires_at: new Date(flow.expiresAt).toISOString(),
    status_url: `${getCallbackHost(req)}/auth/huawei/browser/status/${flow.ticketId}`,
  });
}

export function getBrowserHuaweiLoginStatus(req: Request, res: Response): void {
  const flow = getBrowserLoginFlow(String(req.params.ticketId));
  if (!flow) {
    res.status(404).json({ error: "Login ticket not found" });
    return;
  }

  res.json(getBrowserLoginStatus(flow));
}


export function finalizeBrowserHuaweiLogin(req: Request, res: Response): void {
  const flow = getBrowserLoginFlow(String(req.params.ticketId));
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
  // api_key 直接随响应返回（与 cookie 同信任级：仅持票者可得），供 CLI 验证脚本获取密钥
  // —— cookie 值已加密，无法再从 Set-Cookie 提取明文。
  res.json({ success: true, redirect_url: redirectUrl, api_key: flow.apiKey });
}

export async function handleHuaweiCallback(
  req: Request,
  res: Response,
): Promise<void> {
  clearExpiredLoginFlows();

  // 检测回调格式：新版 OAuth2 (code+state) 还是旧版 (identifier+ticket_id)
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const identifier = typeof req.query.identifier === "string" ? req.query.identifier : undefined;
  const redirect =
    typeof req.query.redirect === "string" ? req.query.redirect : undefined;
  // 开放重定向防护：仅放行相对路径与白名单主机（见 resolveSafeRedirect）。
  const safeRedirect = resolveSafeRedirect(redirect);
  const preferredTicketId =
    typeof req.query.ticket_id === "string"
      ? req.query.ticket_id
      : typeof req.cookies.huawei_login_ticket === "string"
        ? req.cookies.huawei_login_ticket
        : undefined;

  // 新版 OAuth2 回调（code + state）
  if (code && state) {
    logger.info(
      `[huawei-auth] OAuth2 callback received code=${maskValue(code)} state=${maskValue(state)}`,
    );

    // 打印当前所有 login flows 用于调试
    const allFlows = Array.from(loginFlows.entries()).map(([id, f]) => ({
      ticketId: maskValue(id),
      kind: f.kind,
      expiresAt: new Date(f.expiresAt).toISOString(),
      expired: f.expiresAt <= Date.now(),
      hasPkcePair: !!f.pkcePair,
      hasDpopKeyPair: !!f.dpopKeyPair,
    }));
    logger.info(`[huawei-auth] Current login flows: ${allFlows.length}`, { flows: allFlows });

    // 上游实现不使用 state 来匹配登录流程
    // 它只是使用当前活跃的登录流程（通过 running promise）
    // 我们使用类似的方式：找到最近的 pending 流程（API 或 browser）
    const flow = getAnyPendingLoginFlow();

    if (!flow) {
      logger.warn(
        `[huawei-auth] OAuth2 callback: no active login flow found`,
      );
      res.status(400).json(createOpenAIError("No active login flow. Please start a new login."));
      return;
    }

    logger.info(
      `[huawei-auth] OAuth2 callback: using active flow ticketId=${maskValue(flow.ticketId)} kind=${flow.kind}`,
    );

    // 处理 OAuth2 授权码
    await handleOAuth2AuthorizationCode(flow, code, res);
    return;
  }

  // 旧版回调（identifier）
  if (!identifier || typeof identifier !== "string") {
    res.status(400).json(createOpenAIError("Missing identifier or code in callback"));
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

    logger.info(
      `[huawei-auth] callback received ticketId=${maskValue(browserFlow.ticketId)} identifier=${maskValue(identifier)} redirect=${redirect ?? "missing"}`,
    );

    startBrowserFlowExchange(browserFlow, identifier, safeRedirect);
    if (safeRedirect) {
      res.redirect(307, safeRedirect);
      return;
    }

    res.redirect(
      `/auth/huawei/browser/complete?ticket_id=${encodeURIComponent(browserFlow.ticketId)}`,
    );
    return;
  }

  if (!preferredTicketId) {
    logger.warn(
      `[huawei-auth] callback received without correlated ticket identifier=${maskValue(identifier)} redirect=${redirect ?? "missing"}`,
    );
  } else if (!browserFlow) {
    logger.warn(
      `[huawei-auth] callback ticket not found or not browser ticketId=${maskValue(preferredTicketId)} identifier=${maskValue(identifier)}`,
    );
  }

  const apiFlow = getPendingApiLoginFlow(preferredTicketId);
  if (!apiFlow) {
    res.status(400).json(createOpenAIError("Unknown or expired login flow"));
    return;
  }

  logger.info(
    `[huawei-auth] callback received api ticketId=${maskValue(apiFlow.ticketId)} identifier=${maskValue(identifier)} redirect=${redirect ?? "missing"}`,
  );

  loginFlows.set(apiFlow.ticketId, {
    ...apiFlow,
    identifier,
    redirect: safeRedirect,
  });

  if (safeRedirect) {
    res.redirect(307, safeRedirect);
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
