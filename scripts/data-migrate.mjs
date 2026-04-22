#!/usr/bin/env node
/**
 * data-migrate.mjs — 从旧扁平文件格式迁移到新分层目录格式
 *
 * 用法：
 *   node scripts/data-migrate.mjs              执行迁移
 *   node scripts/data-migrate.mjs --dry-run    预览迁移（不写文件）
 *   node scripts/data-migrate.mjs --rollback   从备份恢复旧格式
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "..", "data");
const BACKUP_DIR = path.join(DATA_DIR, ".backup");

// ---------------------------------------------------------------------------
// 加密/解密（与项目一致）
// ---------------------------------------------------------------------------

function getEncryptionKey() {
  const key =
    process.env.ENCRYPTION_KEY || "dev-only-32-byte-encryption-key!";
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

function encryptString(plainText, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
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

function writeEncryptedJson(filePath, data, encryptionKey) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const serialized = JSON.stringify(data);
  fs.writeFileSync(filePath, encryptString(serialized, encryptionKey), "utf8");
}

// ---------------------------------------------------------------------------
// 迁移逻辑
// ---------------------------------------------------------------------------

function migrate(dryRun = false) {
  const encryptionKey = getEncryptionKey();

  const authStorePath = path.join(DATA_DIR, "auth-store.json");
  const sessionsPath = path.join(DATA_DIR, "huawei-sessions.json");
  const adminConfigPath = path.join(DATA_DIR, "admin-config.json");

  // 检查旧文件是否存在
  if (!fs.existsSync(authStorePath)) {
    console.error("错误：未找到旧 auth-store.json，无需迁移");
    process.exit(1);
  }

  // 1. 解密旧文件
  console.log("\n=== 读取旧格式数据 ===\n");
  const authStore = loadJson(authStorePath, encryptionKey);
  const users = authStore.users || [];
  const apiKeys = authStore.apiKeys || [];
  const providerAccounts = authStore.providerAccounts || [];

  let sessions = [];
  if (fs.existsSync(sessionsPath)) {
    const sessionsData = loadJson(sessionsPath, encryptionKey);
    sessions = sessionsData.sessions || [];
  }

  console.log(`  users:            ${users.length}`);
  console.log(`  apiKeys:          ${apiKeys.length}`);
  console.log(`  providerAccounts: ${providerAccounts.length}`);
  console.log(`  sessions:         ${sessions.length}`);

  if (dryRun) {
    console.log("\n=== Dry Run 预览 ===\n");
    console.log("将创建以下目录结构：");
    for (const user of users) {
      console.log(`  data/users/${user.id}/`);
      console.log(`    profile.json`);
      const userAccounts = providerAccounts.filter(
        (a) => a.userId === user.id,
      );
      for (const account of userAccounts) {
        console.log(`    accounts/${account.id}/`);
        console.log(`      account.json`);
        const accountKeys = apiKeys.filter(
          (k) => k.providerAccountId === account.id,
        );
        for (const key of accountKeys) {
          console.log(`      keys/${key.id}/`);
          console.log(`        key.json`);
          console.log(`        session.json`);
        }
      }
    }
    if (fs.existsSync(adminConfigPath)) {
      console.log("  data/admin.json");
    }
    console.log("\n（dry-run 模式，未写入任何文件）");
    return;
  }

  // 2. 备份旧文件
  console.log("\n=== 备份旧文件 ===\n");
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  for (const file of ["auth-store.json", "huawei-sessions.json", "admin-config.json"]) {
    const src = path.join(DATA_DIR, file);
    if (fs.existsSync(src)) {
      const dst = path.join(BACKUP_DIR, file);
      fs.copyFileSync(src, dst);
      console.log(`  ${file} → .backup/${file}`);
    }
  }

  // 3. 创建新目录结构
  console.log("\n=== 创建新格式 ===\n");
  const usersDir = path.join(DATA_DIR, "users");
  fs.mkdirSync(usersDir, { recursive: true });

  // 构建 session 索引：providerAccountId → session
  const sessionByAccount = new Map();
  for (const session of sessions) {
    if (session.providerAccountId) {
      sessionByAccount.set(session.providerAccountId, session);
    }
  }

  let writtenProfiles = 0;
  let writtenAccounts = 0;
  let writtenKeys = 0;
  let writtenSessions = 0;
  let skippedKeys = 0;

  for (const user of users) {
    // 写 profile.json
    const profilePath = path.join(usersDir, user.id, "profile.json");
    writeEncryptedJson(profilePath, user, encryptionKey);
    writtenProfiles++;

    const userAccounts = providerAccounts.filter(
      (a) => a.userId === user.id,
    );

    for (const account of userAccounts) {
      // 写 account.json
      const accountPath = path.join(
        usersDir, user.id, "accounts", account.id, "account.json",
      );
      writeEncryptedJson(accountPath, account, encryptionKey);
      writtenAccounts++;

      // 找到绑定此 account 的 keys
      const accountKeys = apiKeys.filter(
        (k) => k.providerAccountId === account.id,
      );

      for (const key of accountKeys) {
        // 写 key.json
        const keyPath = path.join(
          usersDir, user.id, "accounts", account.id, "keys", key.id, "key.json",
        );
        writeEncryptedJson(keyPath, key, encryptionKey);
        writtenKeys++;

        // 写 session.json（从旧 session 复制，绑定到 key）
        const oldSession = sessionByAccount.get(account.id);
        if (oldSession) {
          const newSession = {
            ...oldSession,
            keyId: key.id,
          };
          const sessionPath = path.join(
            usersDir, user.id, "accounts", account.id, "keys", key.id, "session.json",
          );
          writeEncryptedJson(sessionPath, newSession, encryptionKey);
          writtenSessions++;
        } else {
          console.warn(
            `  ⚠ Key ${key.id} (account ${account.id}) 没有对应的 session，跳过`,
          );
          skippedKeys++;
        }
      }
    }
  }

  // 4. 复制 admin-config.json → admin.json
  if (fs.existsSync(adminConfigPath)) {
    const adminData = loadJson(adminConfigPath, encryptionKey);
    const adminPath = path.join(DATA_DIR, "admin.json");
    fs.writeFileSync(adminPath, JSON.stringify(adminData, null, 2), "utf8");
    console.log(`  admin.json 已写入`);
  }

  console.log("\n=== 迁移结果 ===\n");
  console.log(`  profiles:  ${writtenProfiles}`);
  console.log(`  accounts:  ${writtenAccounts}`);
  console.log(`  keys:      ${writtenKeys}`);
  console.log(`  sessions:  ${writtenSessions}`);
  if (skippedKeys > 0) {
    console.log(`  跳过:     ${skippedKeys} (无 session 的 key)`);
  }

  // 5. 验证
  console.log("\n=== 验证 ===\n");
  let errors = 0;

  if (writtenProfiles !== users.length) {
    console.error(`  ✗ 用户数不匹配：期望 ${users.length}，实际 ${writtenProfiles}`);
    errors++;
  }
  if (writtenAccounts !== providerAccounts.length) {
    console.error(
      `  ✗ 账户数不匹配：期望 ${providerAccounts.length}，实际 ${writtenAccounts}`,
    );
    errors++;
  }
  if (writtenKeys !== apiKeys.length) {
    console.error(`  ✗ Key 数不匹配：期望 ${apiKeys.length}，实际 ${writtenKeys}`);
    errors++;
  }
  if (writtenSessions !== writtenKeys) {
    console.error(`  ✗ Session 数不匹配：期望 ${writtenKeys}（每个 key 一个），实际 ${writtenSessions}`);
    errors++;
  }

  if (errors === 0) {
    console.log("  ✓ 验证通过，数据完整");
  } else {
    console.error(`  ✗ 发现 ${errors} 个错误`);
  }
}

// ---------------------------------------------------------------------------
// 回滚
// ---------------------------------------------------------------------------

function rollback() {
  console.log("\n=== 回滚 ===\n");

  if (!fs.existsSync(BACKUP_DIR)) {
    console.error("错误：未找到备份目录 data/.backup/");
    process.exit(1);
  }

  // 恢复旧文件
  for (const file of ["auth-store.json", "huawei-sessions.json", "admin-config.json"]) {
    const src = path.join(BACKUP_DIR, file);
    if (fs.existsSync(src)) {
      const dst = path.join(DATA_DIR, file);
      fs.copyFileSync(src, dst);
      console.log(`  .backup/${file} → ${file}`);
    }
  }

  // 删除新目录结构
  const usersDir = path.join(DATA_DIR, "users");
  if (fs.existsSync(usersDir)) {
    fs.rmSync(usersDir, { recursive: true, force: true });
    console.log("  已删除 data/users/ 目录");
  }

  const adminPath = path.join(DATA_DIR, "admin.json");
  if (fs.existsSync(adminPath)) {
    fs.unlinkSync(adminPath);
    console.log("  已删除 data/admin.json");
  }

  console.log("\n  ✓ 回滚完成");
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--dry-run")) {
    migrate(true);
  } else if (args.includes("--rollback")) {
    rollback();
  } else {
    migrate(false);
  }
}

main();
