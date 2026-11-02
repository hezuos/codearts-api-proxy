import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { logger } from "../utils/logger";
import type { User } from "../db/models/user";
import type { ApiKey, ApiKeyScope } from "../db/models/api-key";
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
  userKeysDir,
  userKeyDir,
  userKeyPath,
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

/**
 * 会话索引：keyId → accountId → session。
 *
 * 一个 Key 可在多个账号下各持有一条会话，因此会话必须按 (Key, Account)
 * 复合寻址，否则同一 Key 绑定多账号时会互相覆盖。
 */
const sessions = new Map<string, Map<string, StoredHuaweiSession>>();

/**
 * 反向索引：keyId → { userId, accountId, scope }。
 *
 * scope 显式区分账号级与用户级——不再用空账号 ID 兼作作用域标记，
 * 否则"无账号"与"作用域未知"无法分辨，写盘/删除分支会走错。
 */
export interface KeyLocation {
  userId: string;
  /** 首选账号；用户级 Key 为空字符串。 */
  accountId: string;
  scope: ApiKeyScope;
}

const keyLocation = new Map<string, KeyLocation>();

/** Hash an API key value using SHA-256 for secure lookup. */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/** Check if a keyHash value looks like a SHA-256 hex hash (64 hex chars). */
function isHashedKey(value: string): boolean {
  return value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}

/**
 * 归一化 Key 的作用域：旧数据缺省按账号级解释。
 */
export function resolveKeyScope(key: ApiKey): ApiKeyScope {
  return key.scope ?? "account";
}

/**
 * 归一化 Key 绑定的账号列表：旧数据取首选账号。
 */
export function resolveBoundAccountIds(key: ApiKey): string[] {
  if (key.providerAccountIds && key.providerAccountIds.length > 0) {
    return key.providerAccountIds;
  }
  return key.providerAccountId ? [key.providerAccountId] : [];
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

/** 读取用户级 Key：`data/users/{userId}/keys/{keyId}/key.json` */
export function readUserKey(userId: string, keyId: string): ApiKey | null {
  return readEncryptedFile<ApiKey>(userKeyPath(userId, keyId));
}

/** 写入用户级 Key：`data/users/{userId}/keys/{keyId}/key.json` */
export function writeUserKey(
  userId: string,
  keyId: string,
  data: ApiKey,
): void {
  fs.mkdirSync(userKeyDir(userId, keyId), { recursive: true });
  writeEncryptedFile(userKeyPath(userId, keyId), data);
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

/** 列出用户级 Key 目录下的 keyId。 */
export function listUserKeys(userId: string): string[] {
  const dir = userKeysDir(userId);
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

/**
 * 删除 Key：磁盘文件与内存索引 SHALL 同时清除。
 *
 * 账号级 Key 的 session.json 位于**每个绑定账号**的目录下，删除时需全部清除；
 * 用户级 Key 的文件位于用户级目录，路径与账号级完全不同——按 accountId
 * 拼路径会得到不存在的路径，导致内存已清而磁盘残留、重启后 Key 复活。
 */
export function deleteKey(
  userId: string,
  accountId: string,
  keyId: string,
  scope: ApiKeyScope = "account",
): void {
  const apiKey = apiKeys.get(keyId);

  if (scope === "user") {
    deleteFile(userKeyPath(userId, keyId));
    const userKeyDirPath = userKeyDir(userId, keyId);
    try {
      fs.rmSync(userKeyDirPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  } else {
    const boundAccounts = apiKey
      ? resolveBoundAccountIds(apiKey)
      : accountId
        ? [accountId]
        : [];
    for (const bound of boundAccounts.length > 0 ? boundAccounts : [accountId]) {
      deleteFile(sessionPath(userId, bound, keyId));
      deleteFile(keyPath(userId, bound, keyId));
      const dir = keyDir(userId, bound, keyId);
      try {
        fs.rmdirSync(dir); // only removes if empty
      } catch {
        // directory not empty or doesn't exist — ignore
      }
    }
  }

  // Update in-memory caches
  if (apiKey) {
    // Clean hash index.
    //
    // 索引键的形态取决于实体：新建 Key 的 keyHash 仍是明文（加载时才迁移为
    // 哈希），已加载过的 Key 则已是哈希。只按"已是哈希"清理会留下残留条目，
    // 使被删除的 Key 仍能通过认证。
    const hashIndexKey = isHashedKey(apiKey.keyHash)
      ? apiKey.keyHash
      : hashApiKey(apiKey.keyHash);
    apiKeysByHash.delete(hashIndexKey);
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

/**
 * 删除账号：级联清除该账号下的 Key 与会话。
 *
 * 多账号 Key 若仍绑定其它账号，则只移除该账号的绑定与会话，Key 本身保留。
 */
export function deleteAccount(userId: string, accountId: string): void {
  const keyIds = listKeys(userId, accountId);
  for (const keyId of keyIds) {
    const apiKey = apiKeys.get(keyId);
    const bound = apiKey ? resolveBoundAccountIds(apiKey) : [accountId];
    const remaining = bound.filter((id) => id !== accountId);

    if (remaining.length === 0) {
      // 仅绑定该账号（或未显式绑定）→ 连同 Key 一并删除
      deleteKey(userId, accountId, keyId, "account");
    } else {
      // 仍绑定其它账号 → 只移除该账号的会话与绑定
      deleteFile(sessionPath(userId, accountId, keyId));
      if (apiKey) {
        apiKey.providerAccountIds = remaining;
        if (apiKey.providerAccountId === accountId) {
          apiKey.providerAccountId = remaining[0];
        }
        apiKey.updatedAt = new Date().toISOString();
        persistApiKey(apiKey);
      }
    }
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

/**
 * 删除用户：级联删除其全部账号与用户级 Key。
 *
 * 用户级 Key 不在账号目录下，删除用户目录**不足以**把它从内存索引移除——
 * 残留条目将继续通过认证，因此必须显式清理。
 */
export function deleteUser(userId: string): void {
  // Cascade: delete all accounts under this user
  const accountIds = listAccounts(userId);
  for (const accountId of accountIds) {
    deleteAccount(userId, accountId);
  }

  // Cascade: 用户级 Key（不在账号目录下，需显式删除磁盘文件与内存索引）
  for (const keyId of listUserKeys(userId)) {
    deleteKey(userId, "", keyId, "user");
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

/** 按 (Key, Account) 复合寻址取会话。 */
export function getSession(
  keyId: string,
  accountId: string,
): StoredHuaweiSession | undefined {
  return sessions.get(keyId)?.get(accountId);
}

/**
 * 兼容接口：取该 Key 首选账号下的会话。
 *
 * 账号级 Key 只有一条自有会话；用户级 Key 没有自有会话，返回 undefined。
 */
export function getSessionByKeyId(
  keyId: string,
): StoredHuaweiSession | undefined {
  const byAccount = sessions.get(keyId);
  if (!byAccount) return undefined;
  const loc = keyLocation.get(keyId);
  if (loc?.accountId) {
    const preferred = byAccount.get(loc.accountId);
    if (preferred) return preferred;
  }
  return byAccount.values().next().value;
}

export function getKeyLocation(keyId: string): KeyLocation | undefined {
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

/** 全部 (Key, Account) 会话条目。 */
export interface SessionEntry {
  keyId: string;
  accountId: string;
  session: StoredHuaweiSession;
}

export function listSessionEntries(): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const [keyId, byAccount] of sessions.entries()) {
    for (const [accountId, session] of byAccount.entries()) {
      entries.push({ keyId, accountId, session });
    }
  }
  return entries;
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
    scope: resolveKeyScope(apiKey),
  });
  writeApiKey(apiKey);
}

/**
 * 把会话写入内存索引与磁盘。
 *
 * 会话按其**自身所属账号**落盘：`accounts/{accountId}/keys/{keyId}/session.json`。
 */
export function setSession(
  keyId: string,
  session: StoredHuaweiSession,
): void {
  const accountId = session.providerAccountId;
  let byAccount = sessions.get(keyId);
  if (!byAccount) {
    byAccount = new Map<string, StoredHuaweiSession>();
    sessions.set(keyId, byAccount);
  }
  byAccount.set(accountId, session);

  const loc = keyLocation.get(keyId);
  if (loc && loc.scope === "account") {
    writeSession(loc.userId, accountId, keyId, session);
  }
}

/**
 * 删除某个 (Key, Account) 组合下的会话。
 *
 * 用于 Key 解绑某个账号时只清掉该账号下的会话——其余绑定账号的会话保持不变。
 */
export function deleteSession(keyId: string, accountId: string): void {
  const byAccount = sessions.get(keyId);
  if (!byAccount) return;
  byAccount.delete(accountId);
  if (byAccount.size === 0) {
    sessions.delete(keyId);
  }

  const loc = keyLocation.get(keyId);
  if (!loc || loc.scope !== "account") return;
  try {
    const dir = keyDir(loc.userId, accountId, keyId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // 忽略删除错误
  }
}

export function findApiKeyByValue(rawKey: string): ApiKey | undefined {
  // SHA-256 hash lookup only (plaintext index removed at runtime)
  return apiKeysByHash.get(hashApiKey(rawKey));
}

/**
 * 按作用域把 ApiKey 写入磁盘。
 *
 * 用户级 Key 走用户级路径分支——SHALL NOT 因"无账号"而跳过落盘。
 */
function writeApiKey(apiKey: ApiKey): void {
  const loc = keyLocation.get(apiKey.id);
  if (!loc) return;
  if (loc.scope === "user") {
    writeUserKey(loc.userId, apiKey.id, apiKey);
    return;
  }
  // 绑定多个账号时，实体文件按绑定账号冗余存放——删除时逐个清理，
  // 写入时也逐个写入，避免绑定列表变化后磁盘残留旧副本。
  const bound = resolveBoundAccountIds(apiKey);
  const targets =
    bound.length > 0 ? bound : loc.accountId ? [loc.accountId] : [];
  for (const accountId of targets) {
    writeKey(loc.userId, accountId, apiKey.id, apiKey);
  }
  if (apiKey.providerAccountId) {
    loc.accountId = apiKey.providerAccountId;
    keyLocation.set(apiKey.id, loc);
  }
}

/**
 * 仅把 Key 的当前状态落盘，不改动哈希索引。
 *
 * 吊销等状态变更走这里：把 keyHash 当作 rawKey 重新注册会写入
 * hash(hash) 垃圾索引条目。
 */
export function persistApiKey(apiKey: ApiKey): void {
  writeApiKey(apiKey);
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
            loadApiKeyEntity(apiKey, { userId, accountId, scope: "account" });
          }
        } catch (error) {
          logger.warn("Failed to load API key, skipping", { userId, accountId, keyId, error: error instanceof Error ? error.message : String(error) });
        }

        try {
          const session = readSession(userId, accountId, keyId);
          if (session) {
            let byAccount = sessions.get(keyId);
            if (!byAccount) {
              byAccount = new Map<string, StoredHuaweiSession>();
              sessions.set(keyId, byAccount);
            }
            byAccount.set(accountId, session);
          }
        } catch (error) {
          logger.warn("Failed to load session, skipping", { userId, accountId, keyId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    // 用户级 Key：与账号级 Key 并列存放在 users/{userId}/keys/
    const userKeyIds = listUserKeys(userId);
    for (const keyId of userKeyIds) {
      try {
        const apiKey = readUserKey(userId, keyId);
        if (apiKey) {
          loadApiKeyEntity(apiKey, { userId, accountId: "", scope: "user" });
        }
      } catch (error) {
        logger.warn("Failed to load user-scoped API key, skipping", { userId, keyId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  // Clear the legacy plaintext index — all keys are now in the hash index,
  // and findApiKeyByValue only uses apiKeysByHash at runtime.
  if (apiKeysByValue.size > 0) {
    logger.info("Clearing legacy plaintext index after migration", { count: apiKeysByValue.size });
    apiKeysByValue.clear();
  }

  logger.info("Loaded hierarchical store", { users: users.size, accounts: providerAccounts.size, keys: apiKeys.size, sessions: listSessionEntries().length });
}

/**
 * 把一个 ApiKey 实体载入内存索引（账号级与用户级共用）。
 */
function loadApiKeyEntity(
  apiKey: ApiKey,
  location: { userId: string; accountId: string; scope: ApiKeyScope },
): void {
  apiKeys.set(apiKey.id, apiKey);

  // Migrate plaintext keyHash to SHA-256 hash
  if (!isHashedKey(apiKey.keyHash)) {
    // keyHash contains plaintext — keep in legacy index and add hash index
    apiKeysByValue.set(apiKey.keyHash, apiKey);
    apiKeysByHash.set(hashApiKey(apiKey.keyHash), apiKey);
    // Persist the migration: update keyHash to the hash value
    apiKey.keyHash = hashApiKey(apiKey.keyHash);
    persistApiKey(apiKey);
  } else {
    // keyHash is already a hash — only populate hash index
    apiKeysByHash.set(apiKey.keyHash, apiKey);
  }

  keyLocation.set(apiKey.id, location);
}

// ---------------------------------------------------------------------------
// Ensure data directory structure exists
// ---------------------------------------------------------------------------

export function ensureDataDirs(): void {
  fs.mkdirSync(usersDir(), { recursive: true });
}
