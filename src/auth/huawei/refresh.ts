/**
 * Refresh Huawei Cloud temporary credentials via /v2/login/refresh.
 *
 * Uses SDK-HMAC-SHA256 signing.  The signed headers must include:
 *   content-type, host, x-sdk-date, x-security-token
 *
 * Verified working 2026-04-16.
 */
import axios from "axios";
import { config } from "../../config";
import { signRequest, type SigningCredentials } from "./sign";

export interface RefreshableHuaweiSession {
  accessKey: string;
  secretKey: string;
  securityToken: string;
}

export interface HuaweiRefreshResult {
  raw: unknown;
}

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

  const response = await axios.post(refreshUrl, body, {
    timeout: 15000,
    headers: {
      "Content-Type": "application/json",
      "Access-Key": session.accessKey,
      ...signedHeaders,
    },
  });

  return { raw: response.data };
}
