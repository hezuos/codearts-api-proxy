import { dataPath } from "./file-store";

// ---------------------------------------------------------------------------
// Entity path resolvers
// ---------------------------------------------------------------------------

/** data/ */
export function dataDir(): string {
  return dataPath();
}

/** data/admin.json */
export function adminPath(): string {
  return dataPath("admin.json");
}

/** data/users/ */
export function usersDir(): string {
  return dataPath("users");
}

/** data/users/{userId}/ */
export function userDir(userId: string): string {
  return dataPath("users", userId);
}

/** data/users/{userId}/profile.json */
export function profilePath(userId: string): string {
  return dataPath("users", userId, "profile.json");
}

/** data/users/{userId}/accounts/ */
export function accountsDir(userId: string): string {
  return dataPath("users", userId, "accounts");
}

/** data/users/{userId}/accounts/{accountId}/ */
export function accountDir(userId: string, accountId: string): string {
  return dataPath("users", userId, "accounts", accountId);
}

/** data/users/{userId}/accounts/{accountId}/account.json */
export function accountPath(userId: string, accountId: string): string {
  return dataPath("users", userId, "accounts", accountId, "account.json");
}

/** data/users/{userId}/accounts/{accountId}/keys/ */
export function keysDir(userId: string, accountId: string): string {
  return dataPath("users", userId, "accounts", accountId, "keys");
}

/** data/users/{userId}/accounts/{accountId}/keys/{keyId}/ */
export function keyDir(
  userId: string,
  accountId: string,
  keyId: string,
): string {
  return dataPath("users", userId, "accounts", accountId, "keys", keyId);
}

/** data/users/{userId}/accounts/{accountId}/keys/{keyId}/key.json */
export function keyPath(
  userId: string,
  accountId: string,
  keyId: string,
): string {
  return dataPath(
    "users",
    userId,
    "accounts",
    accountId,
    "keys",
    keyId,
    "key.json",
  );
}

/** data/users/{userId}/accounts/{accountId}/keys/{keyId}/session.json */
export function sessionPath(
  userId: string,
  accountId: string,
  keyId: string,
): string {
  return dataPath(
    "users",
    userId,
    "accounts",
    accountId,
    "keys",
    keyId,
    "session.json",
  );
}
