import bcrypt from "bcryptjs";
import { timingSafeEqual } from "crypto";
import { readPlaintextFile, writePlaintextFile } from "../store/file-store";
import { adminPath } from "../store/paths";
import { logger } from "../utils/logger";

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
    logger.info("Using admin password from ADMIN_PASSWORD environment variable");
    return;
  }

  // Try to load from file
  const configPath = adminPath();
  const loaded = readPlaintextFile<AdminConfig>(configPath);
  if (loaded) {
    adminConfig = loaded;
    logger.info("Loaded admin config", { path: configPath });
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
  logger.info("Saved admin config", { path: configPath });
}

export function isAdminConfigured(): boolean {
  return adminPasswordFromEnv !== null || adminConfig !== null;
}

export function checkAdminPassword(password: string): boolean {
  // If password from environment, use timing-safe comparison
  if (adminPasswordFromEnv !== null) {
    const a = Buffer.from(password, "utf8");
    const b = Buffer.from(adminPasswordFromEnv, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
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
      logger.error("Failed to update last_login", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
