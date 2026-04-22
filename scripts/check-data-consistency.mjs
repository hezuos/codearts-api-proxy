#!/usr/bin/env node
/**
 * @deprecated Use data-manager.mjs check instead. This script targets the old flat-file format.
 *
 * check-data-consistency.mjs — 检查 auth-store 和 huawei-sessions 数据一致性
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, "..", "data");

function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY || "dev-only-32-byte-encryption-key!";
  return crypto.createHash("sha256").update(key).digest();
}

function decryptString(cipherText, key) {
  try {
    const payload = Buffer.from(cipherText, "base64");
    const iv = payload.subarray(0, 12);
    const authTag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return cipherText;
  }
}

function isEncrypted(content) {
  try {
    JSON.parse(content);
    return false;
  } catch {
    return true;
  }
}

function loadJson(filePath, encryptionKey) {
  const content = fs.readFileSync(filePath, "utf8");
  if (isEncrypted(content)) {
    return JSON.parse(decryptString(content, encryptionKey));
  }
  return JSON.parse(content);
}

function main() {
  const encryptionKey = getEncryptionKey();

  const authStorePath = path.join(DATA_DIR, "auth-store.json");
  const sessionsPath = path.join(DATA_DIR, "huawei-sessions.json");

  const authStore = loadJson(authStorePath, encryptionKey);
  const sessions = loadJson(sessionsPath, encryptionKey);

  const providerAccountIds = new Set(
    (authStore.providerAccounts || []).map((a) => a.id),
  );
  const sessionAccountIds = new Set(
    (sessions.sessions || []).map((s) => s.providerAccountId),
  );

  console.log("\n=== 数据一致性检查 ===\n");

  console.log(`auth-store.json:`);
  console.log(`  - users: ${authStore.users?.length || 0}`);
  console.log(`  - apiKeys: ${authStore.apiKeys?.length || 0}`);
  console.log(`  - providerAccounts: ${authStore.providerAccounts?.length || 0}`);

  console.log(`\nhuawei-sessions.json:`);
  console.log(`  - sessions: ${sessions.sessions?.length || 0}`);

  // 检查孤立的 providerAccounts（没有对应的 session）
  const orphanProviderAccounts = [...providerAccountIds].filter(
    (id) => !sessionAccountIds.has(id),
  );

  // 检查孤立的 sessions（没有对应的 providerAccount）
  const orphanSessions = [...sessionAccountIds].filter(
    (id) => !providerAccountIds.has(id),
  );

  console.log("\n=== 一致性检查结果 ===\n");

  if (orphanProviderAccounts.length === 0 && orphanSessions.length === 0) {
    console.log("✓ 数据一致，没有孤立数据\n");
  } else {
    if (orphanProviderAccounts.length > 0) {
      console.log(
        `⚠ 发现 ${orphanProviderAccounts.length} 个孤立的 providerAccounts（没有对应的 session）:`,
      );
      for (const id of orphanProviderAccounts) {
        const account = authStore.providerAccounts.find((a) => a.id === id);
        console.log(`  - ${id}`);
        console.log(`    providerUserName: ${account?.providerUserName || "N/A"}`);
        console.log(`    displayName: ${account?.displayName || "N/A"}`);
      }
      console.log();
    }

    if (orphanSessions.length > 0) {
      console.log(
        `⚠ 发现 ${orphanSessions.length} 个孤立的 sessions（没有对应的 providerAccount）:`,
      );
      for (const id of orphanSessions) {
        const session = sessions.sessions.find(
          (s) => s.providerAccountId === id,
        );
        console.log(`  - ${id}`);
        console.log(`    expiresAt: ${session?.expiresAt || "N/A"}`);
        console.log(
          `    lastRefreshedAt: ${session?.lastRefreshedAt || "N/A"}`,
        );
      }
      console.log();
    }
  }

  // 检查已过期的 sessions
  const now = Date.now();
  const expiredSessions = (sessions.sessions || []).filter((s) => {
    if (!s.expiresAt) return false;
    return new Date(s.expiresAt).getTime() <= now;
  });

  if (expiredSessions.length > 0) {
    console.log(`⚠ 发现 ${expiredSessions.length} 个已过期的 sessions:`);
    for (const session of expiredSessions) {
      console.log(`  - ${session.providerAccountId}`);
      console.log(`    expiresAt: ${session.expiresAt}`);
    }
    console.log();
  }

  // 检查已撤销的 API Keys
  const revokedApiKeys = (authStore.apiKeys || []).filter((k) => k.revokedAt);
  if (revokedApiKeys.length > 0) {
    console.log(`ℹ 有 ${revokedApiKeys.length} 个已撤销的 API Keys\n`);
  }

  // 建议
  if (orphanProviderAccounts.length > 0 || orphanSessions.length > 0) {
    console.log("=== 建议操作 ===\n");
    if (orphanProviderAccounts.length > 0) {
      console.log(
        "可以使用以下命令清理孤立的 providerAccounts（通过 admin panel 删除账户）:",
      );
      console.log("  node scripts/debug-decrypt.mjs show auth-store\n");
    }
    if (orphanSessions.length > 0) {
      console.log("可以手动编辑 huawei-sessions.json 删除孤立的 sessions\n");
    }
  }
}

main();
