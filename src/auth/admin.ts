import bcrypt from "bcryptjs";
import { readPlaintextFile, writePlaintextFile } from "../store/file-store";
import { adminPath } from "../store/paths";

export interface AdminConfig {
  password_hash: string;
  created_at: string;
  last_login?: string;
  source: "env" | "setup";
}

let adminConfig: AdminConfig | null = null;
let adminPasswordFromEnv: string | null = null;

export function loadAdminConfig(): void {
  // Check environment variable first (highest priority)
  if (process.env.ADMIN_PASSWORD) {
    adminPasswordFromEnv = process.env.ADMIN_PASSWORD;
    console.log(
      "[admin] Using admin password from ADMIN_PASSWORD environment variable",
    );
    return;
  }

  // Try to load from file
  const configPath = adminPath();
  const loaded = readPlaintextFile<AdminConfig>(configPath);
  if (loaded) {
    adminConfig = loaded;
    console.log(`[admin] Loaded admin config from ${configPath}`);
  } else {
    adminConfig = null;
  }
}

export function saveAdminConfig(password: string): void {
  const passwordHash = bcrypt.hashSync(password, 12);
  const now = new Date().toISOString();

  adminConfig = {
    password_hash: passwordHash,
    created_at: now,
    last_login: now,
    source: "setup",
  };

  const configPath = adminPath();
  writePlaintextFile(configPath, adminConfig);
  console.log(`[admin] Saved admin config to ${configPath}`);
}

export function isAdminConfigured(): boolean {
  return adminPasswordFromEnv !== null || adminConfig !== null;
}

export function checkAdminPassword(password: string): boolean {
  // If password from environment, compare directly
  if (adminPasswordFromEnv !== null) {
    return password === adminPasswordFromEnv;
  }

  // If config from file, use bcrypt comparison
  if (adminConfig !== null) {
    return bcrypt.compareSync(password, adminConfig.password_hash);
  }

  return false;
}

export function updateLastLogin(): void {
  if (adminConfig !== null && adminConfig.source === "setup") {
    adminConfig.last_login = new Date().toISOString();
    const configPath = adminPath();
    try {
      writePlaintextFile(configPath, adminConfig);
    } catch (error) {
      console.error("[admin] Failed to update last_login:", error);
    }
  }
}

export function getAdminSource(): "env" | "setup" | null {
  if (adminPasswordFromEnv !== null) return "env";
  if (adminConfig !== null) return adminConfig.source;
  return null;
}
