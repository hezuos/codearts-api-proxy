import { getSessionByKeyId, setSession, getAllSessions } from "../../store/hierarchical-store";
import { refreshHuaweiSession, refreshHuaweiSessionByToken, refreshHuaweiSessionByOAuth2, type RefreshableHuaweiSession } from "./refresh";
import { logger } from "../../utils/logger";
import type { CredentialFormat } from "../../upstream/huawei/extract-credentials";
import type { DpopKeyPair } from "./dpop";

// Re-export for consumers
export type { CredentialFormat };

export interface StoredHuaweiSession {
  keyId: string;
  providerAccountId: string;
  businessToken?: string;
  accessKey?: string;
  secretKeyCiphertext?: string;
  securityToken?: string;
  expiresAt?: string;
  lastRefreshedAt?: string;

  /** v5.0.2 新增：IAM 刷新令牌，用于 AK/SK 签名刷新失败时的降级路径 */
  refreshToken?: string;
  /** v5.0.2 新增：IAM 登录上下文标识 */
  loginContext?: string;
  /** v5.0.2 新增：凭证来源格式标识 */
  credentialFormat?: CredentialFormat;

  /** v5.0.2 新增：DPoP 密钥对（OAuth2 token exchange 使用） */
  dpopKeyPair?: DpopKeyPair;
  /** v5.0.2 新增：PKCE code_verifier（OAuth2 refresh token 时仍需要） */
  pkceCodeVerifier?: string;
}

// ---------------------------------------------------------------------------
// Session access (delegates to hierarchical store)
// ---------------------------------------------------------------------------

export function getSession(
  keyId: string,
): StoredHuaweiSession | undefined {
  return getSessionByKeyId(keyId);
}

export function storeSession(
  keyId: string,
  session: StoredHuaweiSession,
): void {
  setSession(keyId, session);
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export async function refreshStoredSession(
  keyId: string,
): Promise<StoredHuaweiSession | null> {
  const stored = getSessionByKeyId(keyId);
  if (!stored) {
    return null;
  }

  // v5.0.2 新版 IAM session：优先使用 OAuth2 refresh_token
  if (stored.credentialFormat === "new_iam" && stored.refreshToken && stored.dpopKeyPair && stored.pkceCodeVerifier) {
    try {
      logger.info(`[refresh] Using OAuth2 refresh for new IAM session ${keyId}`);
      const result = await refreshHuaweiSessionByOAuth2(
        stored.refreshToken,
        stored.pkceCodeVerifier,
        stored.dpopKeyPair,
      );
      if (result.credentials) {
        const { encryptString } = await import("../crypto/encryption");
        const updated: StoredHuaweiSession = {
          ...stored,
          accessKey: result.credentials.access_key_id,
          secretKeyCiphertext: encryptString(result.credentials.secret_access_key),
          securityToken: result.credentials.security_token,
          expiresAt: result.credentials.expiration,
          refreshToken: result.refresh_token ?? stored.refreshToken,
          lastRefreshedAt: new Date().toISOString(),
        };
        setSession(keyId, updated);
        return updated;
      }
    } catch (error) {
      logger.warn(`OAuth2 refresh failed for key ${keyId}, trying AK/SK refresh`, {
        error: error instanceof Error ? error.message : String(error),
      });
      // fall through to AK/SK refresh
    }
  }

  // 尝试 AK/SK 签名刷新（如果凭证可用）
  if (
    stored.accessKey &&
    stored.secretKeyCiphertext &&
    stored.securityToken
  ) {
    try {
      const { decryptString } = await import("../crypto/encryption");
      const secretKey = decryptString(stored.secretKeyCiphertext);
      const refreshable: RefreshableHuaweiSession = {
        accessKey: stored.accessKey,
        secretKey,
        securityToken: stored.securityToken,
      };

      const result = await refreshHuaweiSession(refreshable);
      logger.info(`Refresh result for key ${keyId}`, { result: result.raw as Record<string, unknown> });

      return applyRefreshResult(keyId, stored, result.raw);
    } catch (error) {
      logger.warn(`AK/SK refresh failed for key ${keyId}, attempting refresh_token fallback`, {
        error: error instanceof Error ? error.message : String(error),
      });

      // 如果有 refresh_token，尝试降级
      if (stored.refreshToken) {
        return await refreshTokenFallback(keyId, stored);
      }

      throw error;
    }
  }

  // 没有 AK/SK 凭证，但有 refresh_token
  if (stored.refreshToken) {
    logger.info(`No AK/SK credentials for key ${keyId}, using refresh_token`);
    return await refreshTokenFallback(keyId, stored);
  }

  logger.warn(
    `Session for key ${keyId} missing refreshable credentials and no refresh_token`,
  );
  return stored;
}

/**
 * 使用 refresh_token 刷新凭证的降级路径。
 *
 * 优先使用 OAuth2 refresh（如果有 DPoP 和 PKCE 信息），
 * 否则使用旧版 refresh_token 刷新。
 */
async function refreshTokenFallback(
  keyId: string,
  stored: StoredHuaweiSession,
): Promise<StoredHuaweiSession | null> {
  if (!stored.refreshToken) {
    return stored;
  }

  try {
    // 优先使用 OAuth2 refresh（v5.0.2 新版）
    if (stored.dpopKeyPair && stored.pkceCodeVerifier) {
      logger.info(`[refresh] Using OAuth2 refresh_token for key ${keyId}`);
      const result = await refreshHuaweiSessionByOAuth2(
        stored.refreshToken,
        stored.pkceCodeVerifier,
        stored.dpopKeyPair,
      );

      if (result.credentials) {
        // OAuth2 refresh 成功，更新 session
        const { encryptString } = await import("../crypto/encryption");
        const updated: StoredHuaweiSession = {
          ...stored,
          accessKey: result.credentials.access_key_id,
          secretKeyCiphertext: encryptString(result.credentials.secret_access_key),
          securityToken: result.credentials.security_token,
          expiresAt: result.credentials.expiration,
          refreshToken: result.refresh_token ?? stored.refreshToken,
          lastRefreshedAt: new Date().toISOString(),
        };
        setSession(keyId, updated);
        return updated;
      }
    }

    // 降级到旧版 refresh_token 刷新
    logger.info(`[refresh] Using legacy refresh_token for key ${keyId}`);
    const result = await refreshHuaweiSessionByToken(stored.refreshToken);
    logger.info(`Refresh token result for key ${keyId}`, { result: result.raw as Record<string, unknown> });

    return applyRefreshResult(keyId, stored, result.raw);
  } catch (error) {
    logger.error(`Refresh token fallback also failed for key ${keyId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * 应用刷新结果到 session。
 */
async function applyRefreshResult(
  keyId: string,
  stored: StoredHuaweiSession,
  rawResult: unknown,
): Promise<StoredHuaweiSession> {
  const payload = rawResult as Record<string, unknown>;
  const resultPayload =
    payload.result && typeof payload.result === "object"
      ? (payload.result as Record<string, unknown>)
      : payload;
  const credential = (resultPayload.credential ??
    resultPayload.credentials ??
    payload.credential ??
    payload.credentials ??
    resultPayload) as Record<string, unknown>;

  // Update a copy first — if encryptString fails, the cached session remains intact
  const updated: StoredHuaweiSession = {
    ...stored,
    accessKey:
      typeof credential.access === "string"
        ? credential.access
        : stored.accessKey,
    securityToken:
      typeof credential.securitytoken === "string"
        ? credential.securitytoken
        : stored.securityToken,
    expiresAt:
      typeof credential.expires_at === "string"
        ? credential.expires_at
        : stored.expiresAt,
    lastRefreshedAt: new Date().toISOString(),
  };

  if (typeof credential.secret === "string") {
    const { encryptString } = await import("../crypto/encryption");
    updated.secretKeyCiphertext = encryptString(credential.secret);
  }

  setSession(keyId, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** List all key IDs that have sessions */
export function listSessionKeyIds(): string[] {
  return Array.from(getAllSessions().keys());
}

/** Log diagnostic summary of the session cache. */
export function logSessionCacheSummary(): void {
  const now = Date.now();
  const allSessions = getAllSessions();
  for (const [keyId, session] of allSessions.entries()) {
    const expiresAt = session.expiresAt
      ? new Date(session.expiresAt).getTime()
      : NaN;
    const remainingMin = Number.isNaN(expiresAt)
      ? "unknown"
      : `${Math.round((expiresAt - now) / 60_000)}min`;
    logger.info(
      `  session[key=${keyId.slice(0, 8)}...]: AK=${session.accessKey ? "yes" : "no"} expires=${remainingMin}`,
    );
  }
  logger.info(`Session cache total: ${allSessions.size} key sessions`);
}
