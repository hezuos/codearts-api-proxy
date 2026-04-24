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
// Bootstrap (no default key — only creates user)
// ---------------------------------------------------------------------------

export function bootstrapDefaultAuth(): void {
  let user = getDefaultUser();
  if (!user) {
    user = createUser({
      email: "dev@codearts-agent-proxy.local",
      displayName: "Development User",
    });
  }
}
