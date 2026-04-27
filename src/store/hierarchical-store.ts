import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { logger } from "../utils/logger";
import type { User } from "../db/models/user";
import type { ApiKey } from "../db/models/api-key";
import type { ProviderAccount } from "../db/models/provider-account";
import type { StoredHuaweiSession } from "../auth/huawei/session-store";
import {
  readEncryptedFile,
  writeEncryptedFile,
  deleteFile,
  deleteDir,
} from "./file-store";
import {
  usersDir,
  profilePath,
  accountsDir,
  accountPath,
  keysDir,
  keyPath,
  sessionPath,
  userDir,
  accountDir,
  keyDir,
} from "./paths";

// ---------------------------------------------------------------------------
// In-memory caches (read-through from files)
// ---------------------------------------------------------------------------

const users = new Map<string, User>();
const apiKeys = new Map<string, ApiKey>();
const apiKeysByValue = new Map<string, ApiKey>(); // legacy plaintext index (backward compat)
const apiKeysByHash = new Map<string, ApiKey>(); // SHA-256 hash index (new)
const providerAccounts = new Map<string, ProviderAccount>();
const sessions = new Map<string, StoredHuaweiSession>();

// Reverse index: keyId → { userId, accountId }
const keyLocation = new Map<string, { userId: string; accountId: string }>();

/** Hash an API key value using SHA-256 for secure lookup. */
function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/** Check if a keyHash value looks like a SHA-256 hex hash (64 hex chars). */
function isHashedKey(value: string): boolean {
  return value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}

// ---------------------------------------------------------------------------
// Entity read/write
// ---------------------------------------------------------------------------

export function readUserProfile(userId: string): User | null {
  return readEncryptedFile<User>(profilePath(userId));
}

export function writeUserProfile(userId: string, data: User): void {
  fs.mkdirSync(userDir(userId), { recursive: true });
  writeEncryptedFile(profilePath(userId), data);
}

export function readAccount(
  userId: string,
  accountId: string,
): ProviderAccount | null {
  return readEncryptedFile<ProviderAccount>(accountPath(userId, accountId));
}

export function writeAccount(
  userId: string,
  accountId: string,
  data: ProviderAccount,
): void {
  fs.mkdirSync(accountDir(userId, accountId), { recursive: true });
  writeEncryptedFile(accountPath(userId, accountId), data);
}

export function readKey(
  userId: string,
  accountId: string,
  keyId: string,
): ApiKey | null {
  return readEncryptedFile<ApiKey>(keyPath(userId, accountId, keyId));
}

export function writeKey(
  userId: string,
  accountId: string,
  keyId: string,
  data: ApiKey,
): void {
  fs.mkdirSync(keyDir(userId, accountId, keyId), { recursive: true });
  writeEncryptedFile(keyPath(userId, accountId, keyId), data);
}

export function readSession(
  userId: string,
  accountId: string,
  keyId: string,
): StoredHuaweiSession | null {
  return readEncryptedFile<StoredHuaweiSession>(
    sessionPath(userId, accountId, keyId),
  );
}

export function writeSession(
  userId: string,
  accountId: string,
  keyId: string,
  data: StoredHuaweiSession,
): void {
  fs.mkdirSync(keyDir(userId, accountId, keyId), { recursive: true });
  writeEncryptedFile(sessionPath(userId, accountId, keyId), data);
}

// ---------------------------------------------------------------------------
// Entity listing (directory scan)
// ---------------------------------------------------------------------------

export function listUsers(): string[] {
  const dir = usersDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) =>
      fs.statSync(path.join(dir, name)).isDirectory(),
    );
}

export function listAccounts(userId: string): string[] {
  const dir = accountsDir(userId);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) =>
      fs.statSync(path.join(dir, name)).isDirectory(),
    );
}

export function listKeys(userId: string, accountId: string): string[] {
  const dir = keysDir(userId, accountId);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) =>
      fs.statSync(path.join(dir, name)).isDirectory(),
    );
}

// ---------------------------------------------------------------------------
// Cascade deletion
// ---------------------------------------------------------------------------

export function deleteKey(
  userId: string,
  accountId: string,
  keyId: string,
): void {
  // Delete session.json first, then key directory
  deleteFile(sessionPath(userId, accountId, keyId));
  deleteFile(keyPath(userId, accountId, keyId));
  // Remove the key directory if empty
  const dir = keyDir(userId, accountId, keyId);
  try {
    fs.rmdirSync(dir); // only removes if empty
  } catch {
    // directory not empty or doesn't exist — ignore
  }

  // Update in-memory caches
  const apiKey = apiKeys.get(keyId);
  if (apiKey) {
    // Clean hash index
    if (isHashedKey(apiKey.keyHash)) {
      apiKeysByHash.delete(apiKey.keyHash);
    }
    // Clean legacy plaintext index — find by value reference
    for (const [k, v] of apiKeysByValue) {
      if (v.id === keyId) {
        apiKeysByValue.delete(k);
        break;
      }
    }
  }
  apiKeys.delete(keyId);
  sessions.delete(keyId);
  keyLocation.delete(keyId);
}

export function deleteAccount(userId: string, accountId: string): void {
  // Cascade: delete all keys under this account
  const keyIds = listKeys(userId, accountId);
  for (const keyId of keyIds) {
    deleteKey(userId, accountId, keyId);
  }

  // Delete account.json and directory
  deleteFile(accountPath(userId, accountId));
  const dir = accountDir(userId, accountId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  // Update in-memory caches
  providerAccounts.delete(accountId);
}

export function deleteUser(userId: string): void {
  // Cascade: delete all accounts under this user
  const accountIds = listAccounts(userId);
  for (const accountId of accountIds) {
    deleteAccount(userId, accountId);
  }

  // Delete profile.json and user directory
  deleteFile(profilePath(userId));
  deleteDir(userDir(userId));

  // Update in-memory caches
  users.delete(userId);
}

// ---------------------------------------------------------------------------
// In-memory cache accessors
// ---------------------------------------------------------------------------

export function getUser(userId: string): User | undefined {
  return users.get(userId);
}

export function getDefaultUser(): User | undefined {
  return Array.from(users.values())[0];
}

export function getProviderAccount(
  providerAccountId: string,
): ProviderAccount | undefined {
  return providerAccounts.get(providerAccountId);
}

export function getApiKey(apiKeyId: string): ApiKey | undefined {
  return apiKeys.get(apiKeyId);
}

export function getSessionByKeyId(
  keyId: string,
): StoredHuaweiSession | undefined {
  return sessions.get(keyId);
}

export function getKeyLocation(keyId: string):
  | { userId: string; accountId: string }
  | undefined {
  return keyLocation.get(keyId);
}

export function getAllUsers(): User[] {
  return Array.from(users.values());
}

export function getAllApiKeys(): ApiKey[] {
  return Array.from(apiKeys.values());
}

export function getAllProviderAccounts(): ProviderAccount[] {
  return Array.from(providerAccounts.values());
}

export function getAllSessions(): Map<string, StoredHuaweiSession> {
  return new Map(sessions);
}

// ---------------------------------------------------------------------------
// In-memory cache mutations (also persist to file)
// ---------------------------------------------------------------------------

export function setUser(user: User): void {
  users.set(user.id, user);
  writeUserProfile(user.id, user);
}

export function setProviderAccount(account: ProviderAccount): void {
  providerAccounts.set(account.id, account);
  writeAccount(account.userId, account.id, account);
}

export function setApiKey(
  apiKey: ApiKey,
  rawKeyValue: string,
): void {
  apiKeys.set(apiKey.id, apiKey);
  apiKeysByHash.set(hashApiKey(rawKeyValue), apiKey); // SHA-256 hash index
  keyLocation.set(apiKey.id, {
    userId: apiKey.userId,
    accountId: apiKey.providerAccountId ?? "",
  });
  writeApiKey(apiKey);
}

export function setSession(
  keyId: string,
  session: StoredHuaweiSession,
): void {
  sessions.set(keyId, session);
  const loc = keyLocation.get(keyId);
  if (loc) {
    writeSession(loc.userId, loc.accountId, keyId, session);
  }
}

export function findApiKeyByValue(rawKey: string): ApiKey | undefined {
  // SHA-256 hash lookup only (plaintext index removed at runtime)
  return apiKeysByHash.get(hashApiKey(rawKey));
}

/** Write ApiKey to file using its location info */
function writeApiKey(apiKey: ApiKey): void {
  const loc = keyLocation.get(apiKey.id);
  if (loc && loc.accountId) {
    writeKey(loc.userId, loc.accountId, apiKey.id, apiKey);
  }
}

// ---------------------------------------------------------------------------
// Startup: load all entities from disk into memory
// ---------------------------------------------------------------------------

export function loadAllEntities(): void {
  users.clear();
  apiKeys.clear();
  apiKeysByValue.clear();
  apiKeysByHash.clear();
  providerAccounts.clear();
  sessions.clear();
  keyLocation.clear();

  const userIds = listUsers();
  for (const userId of userIds) {
    try {
      const user = readUserProfile(userId);
      if (user) {
        users.set(userId, user);
      }
    } catch (error) {
      logger.warn("Failed to load user profile, skipping", { userId, error: error instanceof Error ? error.message : String(error) });
    }

    const accountIds = listAccounts(userId);
    for (const accountId of accountIds) {
      try {
        const account = readAccount(userId, accountId);
        if (account) {
          providerAccounts.set(accountId, account);
        }
      } catch (error) {
        logger.warn("Failed to load account, skipping", { userId, accountId, error: error instanceof Error ? error.message : String(error) });
      }

      const keyIds = listKeys(userId, accountId);
      for (const keyId of keyIds) {
        try {
          const apiKey = readKey(userId, accountId, keyId);
          if (apiKey) {
            apiKeys.set(keyId, apiKey);

            // Migrate plaintext keyHash to SHA-256 hash
            if (!isHashedKey(apiKey.keyHash)) {
              // keyHash contains plaintext — keep in legacy index and add hash index
              apiKeysByValue.set(apiKey.keyHash, apiKey);
              apiKeysByHash.set(hashApiKey(apiKey.keyHash), apiKey);
              // Persist the migration: update keyHash to the hash value
              apiKey.keyHash = hashApiKey(apiKey.keyHash);
              writeApiKey(apiKey);
            } else {
              // keyHash is already a hash — only populate hash index
              apiKeysByHash.set(apiKey.keyHash, apiKey);
            }

            keyLocation.set(keyId, { userId, accountId });
          }
        } catch (error) {
          logger.warn("Failed to load API key, skipping", { userId, accountId, keyId, error: error instanceof Error ? error.message : String(error) });
        }

        try {
          const session = readSession(userId, accountId, keyId);
          if (session) {
            sessions.set(keyId, session);
          }
        } catch (error) {
          logger.warn("Failed to load session, skipping", { userId, accountId, keyId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }

  logger.info("Loaded hierarchical store", { users: users.size, accounts: providerAccounts.size, keys: apiKeys.size, sessions: sessions.size });
}

// ---------------------------------------------------------------------------
// Ensure data directory structure exists
// ---------------------------------------------------------------------------

export function ensureDataDirs(): void {
  fs.mkdirSync(usersDir(), { recursive: true });
}
