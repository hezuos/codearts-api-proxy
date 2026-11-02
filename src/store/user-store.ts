import { randomUUID } from "crypto";
import type { User } from "../db/models/user";
import {
  getUser,
  getDefaultUser,
  setUser,
  loadAllEntities,
  ensureDataDirs,
  getAllUsers,
} from "../store/hierarchical-store";

/** 邀请口令默认有效期：15 分钟。 */
export const INVITE_TOKEN_TTL_MS = 15 * 60 * 1000;

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

function normalizeEmail(email: string | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export function createUser(input: Pick<User, "email" | "displayName">): User {
  const displayName = (input.displayName ?? "").trim();
  if (!displayName) {
    throw new Error("displayName is required");
  }
  const email = input.email?.trim() ? input.email.trim() : undefined;
  const normalized = normalizeEmail(email);
  if (normalized) {
    const duplicate = getAllUsers().some(
      (u) => normalizeEmail(u.email) === normalized,
    );
    if (duplicate) {
      throw new Error(`User with email ${email} already exists`);
    }
  }

  const now = new Date().toISOString();
  const user: User = {
    id: randomUUID(),
    email,
    displayName,
    createdAt: now,
    updatedAt: now,
  };

  setUser(user);
  return user;
}

export { getUser, getDefaultUser, getAllUsers as listAllUsers };
