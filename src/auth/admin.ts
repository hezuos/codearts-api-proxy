import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";

export interface AdminConfig {
  password_hash: string;
  created_at: string;
  last_login?: string;
  source: "env" | "setup";
}

let adminConfig: AdminConfig | null = null;
let adminPasswordFromEnv: string | null = null;

function getAdminConfigPath(): string {
  return path.resolve(process.cwd(), "data", "admin-config.json");
}

function ensureDataDir(): void {
  const dataDir = path.dirname(getAdminConfigPath());
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

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
  const configPath = getAdminConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf8");
      adminConfig = JSON.parse(raw) as AdminConfig;
      console.log(`[admin] Loaded admin config from ${configPath}`);
    } catch (error) {
      console.error(
        `[admin] Failed to load admin config from ${configPath}:`,
        error,
      );
      adminConfig = null;
    }
  }
}

export function saveAdminConfig(password: string): void {
  ensureDataDir();

  const passwordHash = bcrypt.hashSync(password, 12);
  const now = new Date().toISOString();

  adminConfig = {
    password_hash: passwordHash,
    created_at: now,
    last_login: now,
    source: "setup",
  };

  const configPath = getAdminConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(adminConfig, null, 2), "utf8");
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
    const configPath = getAdminConfigPath();
    try {
      fs.writeFileSync(
        configPath,
        JSON.stringify(adminConfig, null, 2),
        "utf8",
      );
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
