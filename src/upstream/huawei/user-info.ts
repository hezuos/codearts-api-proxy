/**
 * 通过 IAM STS API / refresh_token 获取用户信息（v5.0.2）。
 *
 * 逆向自上游 resolveUserInfo() (line 37936-37947) + tryToResolveUserInfoFromRefreshToken() (line 37949-37956):
 * 1. 先从 refresh_token JWT payload 中解码 user_profile
 * 2. 失败则调 /v5/caller-identity
 *
 * 响应字段映射:
 *   principal_id   → userId
 *   principal_urn  → userName (提取 `:` 后最后一段)
 *   account_id     → domainId
 */

import https from "https";
import { signRequest, type SigningCredentials } from "../../auth/huawei/sign";
import { maskValue } from "../../utils/mask";
import { logger } from "../../utils/logger";

const IAM_STS_HOST = "https://sts.cn-north-4.myhuaweicloud.com";
const CALLER_IDENTITY_PATH = "/v5/caller-identity";

export interface HuaweiUserInfo {
  userId: string;
  userName: string;
  domainId: string;
}

/** /v5/caller-identity 响应结构 */
interface CallerIdentityResponse {
  account_id?: string;
  principal_urn?: string;
  principal_id?: string;
}

/** refresh_token JWT payload 解码后的 user_profile */
interface RefreshTokenUserProfile {
  user_id?: string;
  user_name?: string;
  domain_id?: string;
  [key: string]: unknown;
}

/**
 * 从 refresh_token JWT payload 中解码 user_profile。
 * 逆向自上游 tryToResolveUserInfoFromRefreshToken() (line 37949-37956)。
 */
function tryToResolveUserInfoFromRefreshToken(
  refreshToken: string,
): CallerIdentityResponse | null {
  try {
    const parts = refreshToken.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64").toString("utf8"),
    );
    const userProfile: RefreshTokenUserProfile | undefined =
      payload.user_profile
        ? (typeof payload.user_profile === "string"
            ? JSON.parse(payload.user_profile)
            : payload.user_profile)
        : undefined;
    if (!userProfile?.user_id) return null;
    return {
      account_id: userProfile.domain_id,
      principal_urn: `iam::${userProfile.domain_id}:user:${userProfile.user_name}`,
      principal_id: userProfile.user_id,
    };
  } catch {
    return null;
  }
}

/**
 * 通过 IAM STS API /v5/caller-identity 获取 caller identity。
 * 逆向自上游 getUserInfo() (line 85523-85547)。
 */
async function fetchCallerIdentity(
  credentials: SigningCredentials,
): Promise<CallerIdentityResponse> {
  const url = `${IAM_STS_HOST}${CALLER_IDENTITY_PATH}`;

  const request = {
    method: "GET" as const,
    url,
    headers: {
      "X-Security-Token": credentials.securityToken ?? "",
    },
  };

  const signedHeaders = signRequest(request, credentials);

  const rawData = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        hostname: new URL(url).hostname,
        port: new URL(url).port || 443,
        path: new URL(url).pathname,
        method: "GET",
        headers: { ...signedHeaders },
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
      reject(new Error(`fetchCallerIdentity timeout: ${url}`));
    });
    req.end();
  });

  let parsed: CallerIdentityResponse;
  try {
    parsed = JSON.parse(rawData) as CallerIdentityResponse;
  } catch {
    throw new Error("fetchCallerIdentity: response is not valid JSON");
  }

  if (!parsed.principal_id || !parsed.principal_urn) {
    logger.warn("[fetchCallerIdentity] response missing required fields", {
      response: parsed,
    });
    throw new Error(
      "fetchCallerIdentity: response missing required fields",
    );
  }

  return parsed;
}

/**
 * 获取当前用户信息。
 *
 * 逆向自上游 resolveUserInfo() (line 37936-37947):
 * 1. 先从 refresh_token 解码 user_profile
 * 2. 失败则调 /v5/caller-identity
 *
 * @param credentials - AK/SK + securityToken
 * @param refreshToken - 可选的 refresh_token，用于快速解码用户信息
 */
export async function resolveUserInfo(
  credentials: SigningCredentials,
  refreshToken?: string,
): Promise<HuaweiUserInfo> {
  let result: CallerIdentityResponse | null = null;

  // Step 1: 尝试从 refresh_token 解码
  if (refreshToken) {
    result = tryToResolveUserInfoFromRefreshToken(refreshToken);
    if (result) {
      logger.info("[resolveUserInfo] resolved from refresh_token");
    }
  }

  // Step 2: 失败则调 /v5/caller-identity
  if (!result) {
    result = await fetchCallerIdentity(credentials);
    logger.info("[resolveUserInfo] resolved from /v5/caller-identity");
  }

  // 映射字段（与上游一致，line 37942-37944）
  const userId = result.principal_id!;
  const userName = result.principal_urn!.substring(
    result.principal_urn!.lastIndexOf(":") + 1,
  );
  const domainId = result.account_id ?? "";

  logger.info(
    `[resolveUserInfo] userId=${maskValue(userId)} userName=${userName} domainId=${domainId}`,
  );

  return { userId, userName, domainId };
}
