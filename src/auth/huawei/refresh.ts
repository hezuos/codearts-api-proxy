/**
 * Refresh Huawei Cloud temporary credentials via /v2/login/refresh.
 *
 * Uses SDK-HMAC-SHA256 signing.  The signed headers must include:
 *   content-type, host, x-sdk-date, x-security-token
 *
 * Verified working 2026-04-16.
 */
import https from "https";
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
