import { randomUUID } from "crypto";
import type { ApiKey } from "../db/models/api-key";
import type { ProviderAccount } from "../db/models/provider-account";
import type { User } from "../db/models/user";
import type { StoredHuaweiSession } from "./huawei/session-store";
import {
  getUser,
  getDefaultUser,
  setUser,
  getProviderAccount,
  setProviderAccount,
  getApiKey,
  setApiKey,
  findApiKeyByValue,
  removeApiKeyFromValueIndex as _removeApiKeyFromValueIndex,
  getSessionByKeyId,
  setSession,
  deleteKey,
  deleteAccount,
  getAllUsers,
  getAllApiKeys,
  getAllProviderAccounts,
  loadAllEntities,
  ensureDataDirs,
  listAccounts,
  listKeys,
  getKeyLocation,
} from "../store/hierarchical-store";

export interface AuthContext {
  apiKeyId: string;
  userId: string;
  providerAccountId: string;
  session: StoredHuaweiSession;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export function loadPersistedAuthStore(): void {
  ensureDataDirs();
  loadAllEntities();
}

// ---------------------------------------------------------------------------
// User operations
// ---------------------------------------------------------------------------

export function createUser(input: Pick<User, "email" | "displayName">): User {
  const now = new Date().toISOString();
  const user: User = {
    id: randomUUID(),
    email: input.email,
    displayName: input.displayName,
    createdAt: now,
    updatedAt: now,
  };

  setUser(user);
  return user;
}

export { getUser, getDefaultUser, getAllUsers as listAllUsers };

// ---------------------------------------------------------------------------
// ProviderAccount operations
// ---------------------------------------------------------------------------

export function upsertProviderAccount(
  input: Omit<ProviderAccount, "createdAt" | "updatedAt">,
): ProviderAccount {
  const existing = getProviderAccount(input.id);
  const now = new Date().toISOString();
  const providerAccount: ProviderAccount = {
    ...input,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  setProviderAccount(providerAccount);
  return providerAccount;
}

export function listProviderAccounts(userId: string): ProviderAccount[] {
  return getAllProviderAccounts().filter(
    (providerAccount) => providerAccount.userId === userId,
  );
}

export { getProviderAccount };

export function setDefaultProviderAccount(
  userId: string,
  providerAccountId: string,
): ProviderAccount | null {
  const accounts = listProviderAccounts(userId);
  let selected: ProviderAccount | null = null;

  for (const account of accounts) {
    const updated = upsertProviderAccount({
      ...account,
      isDefault: account.id === providerAccountId,
    });
    if (updated.id === providerAccountId) {
      selected = updated;
    }
  }

  return selected;
}

export { deleteProviderAccountViaStore as deleteProviderAccount };

function deleteProviderAccountViaStore(
  userId: string,
  providerAccountId: string,
): boolean {
  const providerAccount = getProviderAccount(providerAccountId);
  if (!providerAccount || providerAccount.userId !== userId) {
    return false;
  }

  deleteAccount(userId, providerAccountId);
  return true;
}

// ---------------------------------------------------------------------------
// ApiKey operations
// ---------------------------------------------------------------------------

export function issueApiKey(input: {
  userId: string;
  providerAccountId: string;
  name: string;
  rawKey: string;
}): ApiKey {
  const now = new Date().toISOString();
  const apiKey: ApiKey = {
    id: randomUUID(),
    userId: input.userId,
    providerAccountId: input.providerAccountId,
    keyHash: input.rawKey,
    name: input.name,
    createdAt: now,
    updatedAt: now,
  };

  setApiKey(apiKey, input.rawKey);
  return apiKey;
}

export function validateApiKey(rawKey: string): AuthContext | null {
  const apiKey = findApiKeyByValue(rawKey);
  if (!apiKey || apiKey.revokedAt) {
    return null;
  }

  if (!apiKey.providerAccountId) {
    return null;
  }

  const session = getSessionByKeyId(apiKey.id);
  if (!session) {
    return null;
  }

  return {
    apiKeyId: apiKey.id,
    userId: apiKey.userId,
    providerAccountId: apiKey.providerAccountId,
    session,
  };
}

export function getUserApiKey(userId: string): string | null {
  for (const apiKey of getAllApiKeys()) {
    if (apiKey.userId === userId && !apiKey.revokedAt) {
      return apiKey.keyHash;
    }
  }
  return null;
}

export function revokeApiKey(apiKeyId: string): boolean {
  const apiKey = getApiKey(apiKeyId);
  if (!apiKey || apiKey.revokedAt) {
    return false;
  }
  apiKey.revokedAt = new Date().toISOString();
  apiKey.updatedAt = new Date().toISOString();

  const loc = getKeyLocation(apiKeyId);
  if (loc) {
    setApiKey(apiKey, apiKey.keyHash);
  }
  return true;
}

export function listApiKeysByUser(userId: string): ApiKey[] {
  return getAllApiKeys().filter((k) => k.userId === userId);
}

// ---------------------------------------------------------------------------
// Bootstrap (no default key — only creates user)
// ---------------------------------------------------------------------------

export function bootstrapDefaultAuth(_rawApiKey: string): void {
  let user = getDefaultUser();
  if (!user) {
    user = createUser({
      email: "dev@codearts-agent-proxy.local",
      displayName: "Development User",
    });
  }
  // No default key creation — users must OAuth login to get keys
}

// ---------------------------------------------------------------------------
// Re-exports for hierarchical store access
// ---------------------------------------------------------------------------

export {
  getSessionByKeyId,
  setSession,
  getKeyLocation,
  getApiKey,
  listAccounts,
  listKeys,
  deleteKey,
};
