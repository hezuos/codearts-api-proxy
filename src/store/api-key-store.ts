import { randomUUID } from "crypto";
import type { ApiKey } from "../db/models/api-key";
import type { StoredHuaweiSession } from "../auth/huawei/session-store";
import {
  getApiKey,
  setApiKey,
  findApiKeyByValue,
  getSessionByKeyId,
  getAllApiKeys,
  getKeyLocation,
} from "../store/hierarchical-store";

export interface AuthContext {
  apiKeyId: string;
  userId: string;
  providerAccountId: string;
  session: StoredHuaweiSession;
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
// Re-exports for hierarchical store access
// ---------------------------------------------------------------------------

export {
  getSessionByKeyId,
  getKeyLocation,
  getApiKey,
};
