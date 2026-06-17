/**
 * OAuth2 Token Exchange 实现。
 *
 * 逆向自上游 huaweicloud.authentication v5.0.2。
 * 实现 authorization_code 和 refresh_token 两种 grant type。
 *
 * Token 端点: POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
 * Content-Type: application/x-www-form-urlencoded
 * 需要 DPoP header
 */

import https from "https";
import { logger } from "../../utils/logger";
import { maskValue } from "../../utils/mask";
import { generateDpopPayload, generateDpopProof, type DpopKeyPair } from "./dpop";

// ---------------------------------------------------------------------------
// Constants (逆向自上游)
// ---------------------------------------------------------------------------

const IAM_STS_HOST = "https://sts.cn-north-4.myhuaweicloud.com";
const IAM_TOKEN_API = "/v1/oauth2/tokens";
const CLIENT_ID = "codearts-agent";
const AUTH_REDIRECT_URL = "/oauth/callback";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenResponse {
  credentials?: {
    access_key_id: string;
    secret_access_key: string;
    security_token: string;
    expiration: string;
  };
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

export interface AuthorizationCodeParams {
  code: string;
  codeVerifier: string;
  port: number;
  dpopKeyPair: DpopKeyPair;
}

export interface RefreshTokenParams {
  refreshToken: string;
  codeVerifier: string;
  dpopKeyPair: DpopKeyPair;
}

// ---------------------------------------------------------------------------
// HTTP Helper
// ---------------------------------------------------------------------------

function httpsPostForm(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs = 60_000,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          let parsed: unknown;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode ?? 0, data: parsed });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`HTTP request timeout: ${url} (${timeoutMs}ms)`));
    });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Token Exchange
// ---------------------------------------------------------------------------

/**
 * 核心 token 请求函数（逆向自上游 requestToken()）。
 *
 * 1. 生成 DPoP payload (htm, htu, iat, jti)
 * 2. 使用 DPoP 密钥对签名生成 JWT
 * 3. POST 到 token 端点，携带 DPoP header
 */
async function requestToken(
  dpopKeyPair: DpopKeyPair,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const tokenUrl = `${IAM_STS_HOST}${IAM_TOKEN_API}`;

  // 生成 DPoP proof
  const dpopPayload = generateDpopPayload("POST", tokenUrl);
  const dpopProof = await generateDpopProof(dpopKeyPair, dpopPayload);

  // 构造请求体 (form-urlencoded)
  const body = new URLSearchParams(params).toString();

  logger.info(`[token-exchange] Requesting token from ${tokenUrl}`, {
    params: Object.keys(params),
    dpopJti: maskValue(dpopPayload.jti),
    redirectUri: params.redirect_uri,
    clientId: params.client_id,
    grantType: params.grant_type,
    hasCode: !!params.code,
    hasCodeVerifier: !!params.code_verifier,
    hasRefreshToken: !!params.refresh_token,
  });

  // 记录 DPoP proof 用于调试
  logger.debug(`[token-exchange] DPoP proof generated`, {
    proofLength: dpopProof.length,
    proofStart: dpopProof.substring(0, 50) + "...",
  });

  const { status, data } = await httpsPostForm(tokenUrl, body, {
    DPoP: dpopProof,
  });

  const response = data as TokenResponse;

  if (status !== 200) {
    logger.error(`[token-exchange] Token request failed: status=${status}`, {
      error: response.error,
      error_description: response.error_description,
      response: data,
      requestBody: body,
      responseType: typeof data,
      responseString: typeof data === "string" ? data : JSON.stringify(data),
    });
    throw new Error(`Token request failed: ${response.error ?? "unknown"} - ${response.error_description ?? ""}`);
  }

  if (!response.credentials) {
    logger.error("[token-exchange] Token response missing credentials", { data });
    throw new Error("Token response missing credentials");
  }

  logger.info("[token-exchange] Token request successful", {
    access_key_id: maskValue(response.credentials.access_key_id),
    has_refresh_token: !!response.refresh_token,
  });

  return response;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 使用授权码换取 token（逆向自上游 getTokenByAuthenticationCode()）。
 *
 * 请求参数:
 * - client_id: "codearts-agent"
 * - code: 授权码
 * - code_verifier: PKCE code_verifier
 * - grant_type: "authorization_code"
 * - redirect_uri: "http://127.0.0.1:{port}/oauth/callback"
 */
export async function getTokenByAuthorizationCode(
  params: AuthorizationCodeParams,
): Promise<TokenResponse> {
  return requestToken(params.dpopKeyPair, {
    client_id: CLIENT_ID,
    code: params.code,
    code_verifier: params.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: `http://127.0.0.1:${params.port}${AUTH_REDIRECT_URL}`,
  });
}

/**
 * 使用 refresh_token 刷新 token（逆向自上游 refreshToken()）。
 *
 * 请求参数:
 * - client_id: "codearts-agent"
 * - code_verifier: PKCE code_verifier（refresh 时仍需要）
 * - grant_type: "refresh_token"
 * - refresh_token: refresh token
 */
export async function refreshTokenByOAuth2(
  params: RefreshTokenParams,
): Promise<TokenResponse> {
  return requestToken(params.dpopKeyPair, {
    client_id: CLIENT_ID,
    code_verifier: params.codeVerifier,
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
  });
}

/**
 * 获取 OAuth2 回调路径。
 */
export function getAuthRedirectUrl(): string {
  return AUTH_REDIRECT_URL;
}

/**
 * 获取客户端 ID。
 */
export function getClientId(): string {
  return CLIENT_ID;
}
