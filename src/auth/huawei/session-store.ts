import fs from "fs";
import path from "path";
import { config } from "../../config";
import { decryptString, encryptString } from "../crypto/encryption";
import { refreshHuaweiSession, type RefreshableHuaweiSession } from "./refresh";

export interface StoredHuaweiSession {
  providerAccountId: string;
  businessToken?: string;
  accessKey?: string;
  secretKeyCiphertext?: string;
  securityToken?: string;
  expiresAt?: string;
}

const sessionCache = new Map<string, StoredHuaweiSession>();
const refreshLocks = new Map<string, Promise<StoredHuaweiSession | null>>();

function getSessionStorePath(): string {
  return path.resolve(process.cwd(), config.sessionStoreFile);
}

function ensureSessionStoreDir(): void {
  fs.mkdirSync(path.dirname(getSessionStorePath()), { recursive: true });
}

function persistSessions(): void {
  ensureSessionStoreDir();
  const payload = {
    version: 1,
    sessions: Array.from(sessionCache.values()),
  };
  const serialized = JSON.stringify(payload);
  fs.writeFileSync(getSessionStorePath(), encryptString(serialized), "utf8");
}

export function loadPersistedSessions(): void {
  const filePath = getSessionStorePath();
  if (!fs.existsSync(filePath)) {
    return;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const payload = JSON.parse(decryptString(raw)) as {
      sessions?: StoredHuaweiSession[];
    };

    sessionCache.clear();
    for (const session of payload.sessions ?? []) {
      if (!session.providerAccountId) {
        continue;
      }
      sessionCache.set(session.providerAccountId, session);
    }

    console.log(
      `Loaded ${sessionCache.size} persisted Huawei session(s) from ${filePath}`,
    );
  } catch (error) {
    console.error(`Failed to load persisted sessions from ${filePath}:`, error);
  }
}

export function listSessionProviderAccountIds(): string[] {
  return Array.from(sessionCache.keys());
}

export function getSession(
  providerAccountId: string,
): StoredHuaweiSession | undefined {
  return sessionCache.get(providerAccountId);
}

export function storeSession(
  providerAccountId: string,
  session: StoredHuaweiSession,
): void {
  sessionCache.set(providerAccountId, session);
  persistSessions();
}

export function deleteSession(providerAccountId: string): void {
  sessionCache.delete(providerAccountId);
  persistSessions();
}

export async function refreshStoredSession(
  providerAccountId: string,
): Promise<StoredHuaweiSession | null> {
  const existingLock = refreshLocks.get(providerAccountId);
  if (existingLock) {
    return existingLock;
  }

  const refreshPromise = refreshStoredSessionInternal(
    providerAccountId,
  ).finally(() => {
    refreshLocks.delete(providerAccountId);
  });
  refreshLocks.set(providerAccountId, refreshPromise);
  return refreshPromise;
}

async function refreshStoredSessionInternal(
  providerAccountId: string,
): Promise<StoredHuaweiSession | null> {
  const stored = sessionCache.get(providerAccountId);
  if (!stored) {
    return null;
  }

  if (
    !stored.accessKey ||
    !stored.secretKeyCiphertext ||
    !stored.securityToken
  ) {
    console.warn(
      `Session for ${providerAccountId} missing refreshable credentials`,
    );
    return stored;
  }

  const secretKey = decryptString(stored.secretKeyCiphertext);
  const refreshable: RefreshableHuaweiSession = {
    accessKey: stored.accessKey,
    secretKey,
    securityToken: stored.securityToken,
  };

  const result = await refreshHuaweiSession(refreshable);
  console.log(`Refresh result for ${providerAccountId}:`, result.raw);

  const payload = result.raw as Record<string, unknown>;
  const credential = (payload.credential ??
    payload.credentials ??
    payload) as Record<string, unknown>;

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
  if (typeof credential.secret === "string") {
    const { encryptString } = await import("../crypto/encryption");
    stored.secretKeyCiphertext = encryptString(credential.secret);
  }

  sessionCache.set(providerAccountId, stored);
  persistSessions();

  return stored;
}

/** Log diagnostic summary of the session cache. */
export function logSessionCacheSummary(): void {
  const now = Date.now();
  for (const [id, session] of sessionCache.entries()) {
    const expiresAt = session.expiresAt
      ? new Date(session.expiresAt).getTime()
      : NaN;
    const remainingMin = Number.isNaN(expiresAt)
      ? "unknown"
      : `${Math.round((expiresAt - now) / 60_000)}min`;
    console.log(
      `  session[${id}]: AK=${session.accessKey ? "yes" : "no"} expires=${remainingMin}`,
    );
  }
  console.log(`Session cache total: ${sessionCache.size} provider sessions`);
}
