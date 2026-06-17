/**
 * Refresh Huawei Cloud temporary credentials.
 *
 * 支持三种刷新方式：
 * 1. AK/SK 签名刷新（/v2/login/refresh）
 * 2. refresh_token 刷新（旧版 /v2/login/refresh）
 * 3. OAuth2 refresh_token 刷新（新版 /v1/oauth2/tokens + DPoP）
 */
import https from "https";
import { config } from "../../config";
import { signRequest, type SigningCredentials } from "./sign";
import { logger } from "../../utils/logger";
import { refreshTokenByOAuth2, type TokenResponse } from "./token-exchange";
import type { DpopKeyPair } from "./dpop";

export interface RefreshableHuaweiSession {
  accessKey: string;
  secretKey: string;
  securityToken: string;
}

export interface HuaweiRefreshResult {
  raw: unknown;
}

/**
 * 使用 AK/SK 签名刷新凭证（现有方式）。
 */
export async function refreshHuaweiSession(
  session: RefreshableHuaweiSession,
): Promise<HuaweiRefreshResult> {
  const refreshUrl = `${config.huaweiApiHost}/v2/login/refresh`;
  const body = JSON.stringify({ duration_seconds: 86400 });

  const credentials: SigningCredentials = {
    accessKey: session.accessKey,
    secretKey: session.secretKey,
    securityToken: session.securityToken,
  };

  // Sign with content-type — the sign module adds host, x-sdk-date,
  // and x-security-token automatically.
  const signedHeaders = signRequest(
    {
      method: "POST",
      url: refreshUrl,
      headers: { "Content-Type": "application/json" },
      body,
    },
    credentials,
  );

  const url = new URL(refreshUrl);
  const allHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Key": session.accessKey,
    ...signedHeaders,
    "Content-Length": String(Buffer.byteLength(body)),
  };

  const rawData = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: allHeaders,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => resolve(data));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error(`Refresh request timeout: ${refreshUrl}`));
    });
    req.write(body);
    req.end();
  });

  let parsed: unknown;
  try { parsed = JSON.parse(rawData); } catch { parsed = rawData; }
  return { raw: parsed };
}

/**
 * 使用 refresh_token 刷新凭证（v5.0.2 新增降级路径）。
 *
 * 当 AK/SK 签名刷新失败（如凭证已过期）时，使用 refresh_token 作为降级方案。
 * refresh_token 不依赖 AK/SK 签名，可以在 AK/SK 失效时继续刷新。
 */
export async function refreshHuaweiSessionByToken(
  refreshToken: string,
): Promise<HuaweiRefreshResult> {
  const refreshUrl = `${config.huaweiApiHost}/v2/login/refresh`;
  const body = JSON.stringify({
    refresh_token: refreshToken,
    duration_seconds: 86400,
  });

  const url = new URL(refreshUrl);
  const allHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
  };

  logger.info("[refresh-token] Attempting refresh via refresh_token");

  const rawData = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: allHeaders,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => resolve(data));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error(`Refresh token request timeout: ${refreshUrl}`));
    });
    req.write(body);
    req.end();
  });

  let parsed: unknown;
  try { parsed = JSON.parse(rawData); } catch { parsed = rawData; }
  return { raw: parsed };
}

/**
 * 使用 OAuth2 refresh_token 刷新凭证（v5.0.2 新版）。
 *
 * 逆向自上游 refreshToken()：
 * - 使用 DPoP + PKCE code_verifier
 * - 调用 POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
 * - grant_type=refresh_token
 */
export async function refreshHuaweiSessionByOAuth2(
  refreshToken: string,
  codeVerifier: string,
  dpopKeyPair: DpopKeyPair,
): Promise<TokenResponse> {
  logger.info("[refresh-oauth2] Attempting refresh via OAuth2 refresh_token");

  return refreshTokenByOAuth2({
    refreshToken,
    codeVerifier,
    dpopKeyPair,
  });
}
