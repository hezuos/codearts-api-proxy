import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { config } from "../config";
import type { ApiKey } from "../db/models/api-key";
import type { ProviderAccount } from "../db/models/provider-account";
import type { User } from "../db/models/user";
import { decryptString, encryptString } from "./crypto/encryption";

export interface AuthContext {
  apiKeyId: string;
  userId: string;
  providerAccountId?: string;
}

const users = new Map<string, User>();
const apiKeys = new Map<string, ApiKey>();
const apiKeysByValue = new Map<string, ApiKey>();
const providerAccounts = new Map<string, ProviderAccount>();

function getAuthStorePath(): string {
  return path.resolve(process.cwd(), config.authStoreFile);
}

function ensureAuthStoreDir(): void {
  fs.mkdirSync(path.dirname(getAuthStorePath()), { recursive: true });
}

function persistAuthStore(): void {
  ensureAuthStoreDir();
  const payload = {
    version: 1,
    users: Array.from(users.values()),
    apiKeys: Array.from(apiKeys.values()),
    providerAccounts: Array.from(providerAccounts.values()),
  };
  fs.writeFileSync(
    getAuthStorePath(),
    encryptString(JSON.stringify(payload)),
    "utf8",
  );
}

export function loadPersistedAuthStore(): void {
  const filePath = getAuthStorePath();
  if (!fs.existsSync(filePath)) {
    return;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const payload = JSON.parse(decryptString(raw)) as {
      users?: User[];
      apiKeys?: ApiKey[];
      providerAccounts?: ProviderAccount[];
    };

    users.clear();
    apiKeys.clear();
    apiKeysByValue.clear();
    providerAccounts.clear();

    for (const user of payload.users ?? []) {
      users.set(user.id, user);
    }
    for (const apiKey of payload.apiKeys ?? []) {
      apiKeys.set(apiKey.id, apiKey);
      apiKeysByValue.set(apiKey.keyHash, apiKey);
    }
    for (const providerAccount of payload.providerAccounts ?? []) {
      providerAccounts.set(providerAccount.id, providerAccount);
    }

    console.log(
      `Loaded persisted auth store from ${filePath}: users=${users.size} apiKeys=${apiKeys.size} providerAccounts=${providerAccounts.size}`,
    );
  } catch (error) {
    console.error(
      `Failed to load persisted auth store from ${filePath}:`,
      error,
    );
  }
}

export function createUser(input: Pick<User, "email" | "displayName">): User {
  const now = new Date().toISOString();
  const user: User = {
    id: randomUUID(),
    email: input.email,
    displayName: input.displayName,
    createdAt: now,
    updatedAt: now,
  };

  users.set(user.id, user);
  persistAuthStore();
  return user;
}

export function getUser(userId: string): User | undefined {
  return users.get(userId);
}

export function getDefaultUser(): User | undefined {
  return Array.from(users.values())[0];
}

export function upsertProviderAccount(
  input: Omit<ProviderAccount, "createdAt" | "updatedAt">,
): ProviderAccount {
  const existing = providerAccounts.get(input.id);
  const now = new Date().toISOString();
  const providerAccount: ProviderAccount = {
    ...input,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  providerAccounts.set(providerAccount.id, providerAccount);
  persistAuthStore();
  return providerAccount;
}

export function listProviderAccounts(userId: string): ProviderAccount[] {
  return Array.from(providerAccounts.values()).filter(
    (providerAccount) => providerAccount.userId === userId,
  );
}

export function getProviderAccount(
  providerAccountId: string,
): ProviderAccount | undefined {
  return providerAccounts.get(providerAccountId);
}

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

export function deleteProviderAccount(
  userId: string,
  providerAccountId: string,
): boolean {
  const providerAccount = providerAccounts.get(providerAccountId);
  if (!providerAccount || providerAccount.userId !== userId) {
    return false;
  }

  providerAccounts.delete(providerAccountId);
  for (const apiKey of apiKeys.values()) {
    if (apiKey.providerAccountId === providerAccountId) {
      apiKey.revokedAt = new Date().toISOString();
      apiKeys.set(apiKey.id, apiKey);
    }
  }

  persistAuthStore();

  return true;
}

export function issueApiKey(input: {
  userId: string;
  providerAccountId?: string;
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

  apiKeys.set(apiKey.id, apiKey);
  apiKeysByValue.set(input.rawKey, apiKey);
  persistAuthStore();
  return apiKey;
}

export function validateApiKey(rawKey: string): AuthContext | null {
  const apiKey = apiKeysByValue.get(rawKey);
  if (!apiKey || apiKey.revokedAt) {
    return null;
  }

  return {
    apiKeyId: apiKey.id,
    userId: apiKey.userId,
    providerAccountId: apiKey.providerAccountId,
  };
}

export function getUserApiKey(userId: string): string | null {
  for (const apiKey of apiKeys.values()) {
    if (apiKey.userId === userId && !apiKey.revokedAt) {
      return apiKey.keyHash;
    }
  }
  return null;
}

export function revokeApiKey(apiKeyId: string): boolean {
  const apiKey = apiKeys.get(apiKeyId);
  if (!apiKey || apiKey.revokedAt) {
    return false;
  }
  apiKey.revokedAt = new Date().toISOString();
  apiKey.updatedAt = new Date().toISOString();
  apiKeys.set(apiKeyId, apiKey);
  persistAuthStore();
  return true;
}

export function listApiKeysByUser(userId: string): ApiKey[] {
  return Array.from(apiKeys.values()).filter((k) => k.userId === userId);
}

export function listAllUsers(): User[] {
  return Array.from(users.values());
}

export function bootstrapDefaultAuth(rawApiKey: string): AuthContext {
  let user = getDefaultUser();
  if (!user) {
    user = createUser({
      email: "dev@codearts-agent-proxy.local",
      displayName: "Development User",
    });
  }

  let apiKey = apiKeysByValue.get(rawApiKey);
  if (!apiKey) {
    // Issue API key without binding to a specific provider account.
    // It will be resolved to the user's default account at request time.
    apiKey = issueApiKey({
      userId: user.id,
      providerAccountId: undefined,
      name: "default",
      rawKey: rawApiKey,
    });
  }

  return {
    apiKeyId: apiKey.id,
    userId: user.id,
    providerAccountId: apiKey.providerAccountId,
  };
}
