import { getSessionByKeyId, setSession, getAllSessions } from "../../store/hierarchical-store";
import { refreshHuaweiSession, type RefreshableHuaweiSession } from "./refresh";

export interface StoredHuaweiSession {
  keyId: string;
  providerAccountId: string;
  businessToken?: string;
  accessKey?: string;
  secretKeyCiphertext?: string;
  securityToken?: string;
  expiresAt?: string;
  lastRefreshedAt?: string;
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

  if (
    !stored.accessKey ||
    !stored.secretKeyCiphertext ||
    !stored.securityToken
  ) {
    console.warn(
      `Session for key ${keyId} missing refreshable credentials`,
    );
    return stored;
  }

  const { decryptString } = await import("../crypto/encryption");
  const secretKey = decryptString(stored.secretKeyCiphertext);
  const refreshable: RefreshableHuaweiSession = {
    accessKey: stored.accessKey,
    secretKey,
    securityToken: stored.securityToken,
  };

  const result = await refreshHuaweiSession(refreshable);
  console.log(`Refresh result for key ${keyId}:`, result.raw);

  const payload = result.raw as Record<string, unknown>;
  const resultPayload =
    payload.result && typeof payload.result === "object"
      ? (payload.result as Record<string, unknown>)
      : payload;
  const credential = (resultPayload.credential ??
    resultPayload.credentials ??
    payload.credential ??
    payload.credentials ??
    resultPayload) as Record<string, unknown>;

  stored.accessKey =
    typeof credential.access === "string"
      ? credential.access
      : stored.accessKey;
  stored.securityToken =
    typeof credential.securitytoken === "string"
      ? credential.securitytoken
      : stored.securityToken;
  stored.expiresAt =
    typeof credential.expires_at === "string"
      ? credential.expires_at
      : stored.expiresAt;
  stored.lastRefreshedAt = new Date().toISOString();
  if (typeof credential.secret === "string") {
    const { encryptString } = await import("../crypto/encryption");
    stored.secretKeyCiphertext = encryptString(credential.secret);
  }

  setSession(keyId, stored);
  return stored;
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
    console.log(
      `  session[key=${keyId.slice(0, 8)}...]: AK=${session.accessKey ? "yes" : "no"} expires=${remainingMin}`,
    );
  }
  console.log(`Session cache total: ${allSessions.size} key sessions`);
}
