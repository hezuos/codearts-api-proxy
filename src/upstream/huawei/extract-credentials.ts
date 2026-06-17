/**
 * 凭证格式检测与解析（v5.0.2 新版 IAM 登录格式支持）。
 *
 * 上游 `huaweicloud.authentication` v5.0.2 默认使用新版 IAM 登录流程，
 * 响应格式与旧版不同：
 *   旧格式: credential.access / credential.secret / credential.securitytoken / credential.expires_at
 *   新格式: credentials.access_key_id / credentials.secret_access_key / credentials.security_token / credentials.expiration
 *   新增:   refresh_token
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CredentialFormat = "new_iam" | "legacy";

export interface ExtractedIamCredentials {
  accessKey: string;
  secretKey: string;
  securityToken: string;
  expiresAt: string;
}

export interface NewIamCredentials {
  access_key_id: string;
  secret_access_key: string;
  security_token: string;
  expiration: string;
}

export interface NewIamLoginPayload {
  credentials: NewIamCredentials;
  refresh_token: string;
  user_id?: string;
  user_name?: string;
  domain_id?: string;
  [key: string]: unknown;  // 允许 Record<string, unknown> 兼容
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * 检测 ticket 交换响应是否为 NewIamLogin 格式。
 *
 * 判断依据：顶层存在 `credentials.access_key_id` 字段。
 * 旧格式使用 `credential.access`（无 s），新格式使用 `credentials.access_key_id`。
 */
export function isNewIamLoginPayload(
  payload: Record<string, unknown>,
): payload is NewIamLoginPayload {
  if (!payload.credentials || typeof payload.credentials !== "object") {
    return false;
  }
  const creds = payload.credentials as Record<string, unknown>;
  return typeof creds.access_key_id === "string" && creds.access_key_id.length > 0;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * 从新格式 payload 提取凭证。
 */
export function extractNewIamCredentials(
  payload: NewIamLoginPayload,
): ExtractedIamCredentials {
  return {
    accessKey: payload.credentials.access_key_id,
    secretKey: payload.credentials.secret_access_key,
    securityToken: payload.credentials.security_token,
    expiresAt: payload.credentials.expiration,
  };
}

/**
 * 从新格式 payload 提取 refresh_token。
 * refresh_token 在 NewIamLogin 响应中为顶层字段。
 */
export function extractRefreshToken(
  payload: NewIamLoginPayload,
): string | undefined {
  return typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
    ? payload.refresh_token
    : undefined;
}

/**
 * 从新格式 payload 提取用户信息（如果可用）。
 */
export function extractUserInfo(
  payload: NewIamLoginPayload,
): { userId?: string; userName?: string; domainId?: string } {
  return {
    userId: typeof payload.user_id === "string" ? payload.user_id : undefined,
    userName: typeof payload.user_name === "string" ? payload.user_name : undefined,
    domainId: typeof payload.domain_id === "string" ? payload.domain_id : undefined,
  };
}
