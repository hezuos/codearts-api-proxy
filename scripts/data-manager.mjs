#!/usr/bin/env node
/**
 * data-manager.mjs — 分层目录存储的数据管理 CLI
 *
 * 用法：
 *   node scripts/data-manager.mjs list                          列出所有用户/账户/key
 *   node scripts/data-manager.mjs show user <userId>            查看用户（掩码）
 *   node scripts/data-manager.mjs show account <accountId>      查看账户（掩码）
 *   node scripts/data-manager.mjs show key <keyId>              查看 key（掩码）
 *   node scripts/data-manager.mjs show session <keyId>          查看凭证（掩码）
 *   node scripts/data-manager.mjs reveal session <keyId>        完整凭证（不掩码）
 *   node scripts/data-manager.mjs tree                          ASCII 树形展示
 *   node scripts/data-manager.mjs export session <keyId> [out]  导出为明文 JSON
 *   node scripts/data-manager.mjs check                         一致性检查
 *   node scripts/data-manager.mjs migrate [--dry-run]           调用迁移脚本
 *   node scripts/data-manager.mjs rekey --old <k> --new <k>     重加密所有文件
 *
 * 选项：
 *   --key <key>   使用自定义加密密钥
 *   --no-mask     不掩码敏感字段
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "..", "data");

// ---------------------------------------------------------------------------
// 加密/解密
// ---------------------------------------------------------------------------

function getEncryptionKey(customKey) {
  const key = customKey || process.env.ENCRYPTION_KEY || "dev-only-32-byte-encryption-key!";
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
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function isEncrypted(content) {
  try { JSON.parse(content); return false; } catch { return true; }
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
  fs.writeFileSync(filePath, encryptString(JSON.stringify(data), encryptionKey), "utf8");
}

// ---------------------------------------------------------------------------
// 敏感字段掩码
// ---------------------------------------------------------------------------

const SENSITIVE_FIELDS = new Set([
  "secretKey", "secretKeyCiphertext", "secret", "securityToken",
  "securitytoken", "passwordHash", "keyHash", "businessToken",
  "cloudDragonToken", "accessToken",
]);

function maskValue(value, depth = 0) {
  if (depth > 10) return value;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length <= 8) return `**** (${value.length} chars)`;
    return `${value.slice(0, 4)}...${value.slice(-4)} (${value.length} chars)`;
  }
  if (Array.isArray(value)) return value.map((v) => maskValue(v, depth + 1));
  if (typeof value === "object") {
    const masked = {};
    for (const [k, v] of Object.entries(value)) masked[k] = maskValue(v, depth + 1);
    return masked;
  }
  return value;
}

function maskSensitive(obj, shouldMask = true) {
  if (!shouldMask) return obj;
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((item) => maskSensitive(item, shouldMask));
  if (typeof obj === "object") {
    const masked = {};
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_FIELDS.has(key)) {
        masked[key] = maskValue(value);
      } else if (typeof value === "object" && value !== null) {
        masked[key] = maskSensitive(value, shouldMask);
      } else {
        masked[key] = value;
      }
    }
    return masked;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// 实体查找辅助
// ---------------------------------------------------------------------------

function findEntityPath(type, id, encryptionKey) {
  const usersDir = path.join(DATA_DIR, "users");
  if (!fs.existsSync(usersDir)) return null;

  for (const userId of fs.readdirSync(usersDir)) {
    const userDir = path.join(usersDir, userId);
    if (!fs.statSync(userDir).isDirectory()) continue;

    if (type === "user" && userId === id) {
      return { path: path.join(userDir, "profile.json"), userId };
    }

    const accountsDir = path.join(userDir, "accounts");
    if (!fs.existsSync(accountsDir)) continue;

    for (const accountId of fs.readdirSync(accountsDir)) {
      const accountDir = path.join(accountsDir, accountId);
      if (!fs.statSync(accountDir).isDirectory()) continue;

      if (type === "account" && accountId === id) {
        return { path: path.join(accountDir, "account.json"), userId, accountId };
      }

      const keysDir = path.join(accountDir, "keys");
      if (!fs.existsSync(keysDir)) continue;

      for (const keyId of fs.readdirSync(keysDir)) {
        const keyDir = path.join(keysDir, keyId);
        if (!fs.statSync(keyDir).isDirectory()) continue;

        if (type === "key" && keyId === id) {
          return { path: path.join(keyDir, "key.json"), userId, accountId, keyId };
        }
        if (type === "session" && keyId === id) {
          return { path: path.join(keyDir, "session.json"), userId, accountId, keyId };
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

function cmdList() {
  const usersDir = path.join(DATA_DIR, "users");
  if (!fs.existsSync(usersDir)) {
    console.log("无数据");
    return;
  }

  console.log("\n=== 数据实体列表 ===\n");
  for (const userId of fs.readdirSync(usersDir)) {
    const userDir = path.join(usersDir, userId);
    if (!fs.statSync(userDir).isDirectory()) continue;
    console.log(`用户: ${userId}`);

    const accountsDir = path.join(userDir, "accounts");
    if (!fs.existsSync(accountsDir)) continue;
    for (const accountId of fs.readdirSync(accountsDir)) {
      const accountDir = path.join(accountsDir, accountId);
      if (!fs.statSync(accountDir).isDirectory()) continue;
      console.log(`  账户: ${accountId}`);

      const keysDir = path.join(accountDir, "keys");
      if (!fs.existsSync(keysDir)) continue;
      for (const keyId of fs.readdirSync(keysDir)) {
        const keyDir = path.join(keysDir, keyId);
        if (!fs.statSync(keyDir).isDirectory()) continue;
        const hasSession = fs.existsSync(path.join(keyDir, "session.json"));
        console.log(`    Key: ${keyId} ${hasSession ? "[有session]" : "[无session]"}`);
      }
    }
  }
}

function cmdShow(type, id, options) {
  const encryptionKey = getEncryptionKey(options.key);
  const found = findEntityPath(type, id, encryptionKey);
  if (!found) {
    console.error(`未找到 ${type}: ${id}`);
    process.exit(1);
  }

  const data = loadJson(found.path, encryptionKey);
  const display = maskSensitive(data, options.mask);
  console.log(`\n${type}: ${id}`);
  console.log(`路径: ${found.path}\n`);
  console.log(JSON.stringify(display, null, 2));
}

function cmdReveal(type, id, options) {
  const encryptionKey = getEncryptionKey(options.key);
  const found = findEntityPath(type, id, encryptionKey);
  if (!found) {
    console.error(`未找到 ${type}: ${id}`);
    process.exit(1);
  }

  const data = loadJson(found.path, encryptionKey);
  console.log(`\n${type}: ${id}`);
  console.log(`路径: ${found.path}\n`);
  console.warn("⚠️  显示完整内容，包含敏感信息！\n");
  console.log(JSON.stringify(data, null, 2));
}

function cmdTree() {
  console.log(`\n${DATA_DIR}/`);

  function walk(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir).sort();
    const filtered = entries.filter((e) => e !== ".backup");
    filtered.forEach((name, i) => {
      const fullPath = path.join(dir, name);
      const isLast = i === filtered.length - 1;
      const connector = isLast ? "└── " : "├── ";

      if (fs.statSync(fullPath).isDirectory()) {
        console.log(`${prefix}${connector}${name}/`);
        walk(fullPath, prefix + (isLast ? "    " : "│   "));
      } else {
        const content = fs.readFileSync(fullPath, "utf8");
        const encTag = isEncrypted(content) ? "[加密]" : "[明文]";
        const size = fs.statSync(fullPath).size;
        console.log(`${prefix}${connector}${name} ${encTag} (${size}B)`);
      }
    });
  }

  walk(DATA_DIR, "");
}

function cmdExport(type, id, outputPath, options) {
  const encryptionKey = getEncryptionKey(options.key);
  const found = findEntityPath(type, id, encryptionKey);
  if (!found) {
    console.error(`未找到 ${type}: ${id}`);
    process.exit(1);
  }

  const data = loadJson(found.path, encryptionKey);
  const outPath = outputPath || `./${type}-${id}-export.json`;
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`\n✓ 已导出到: ${outPath}\n`);
}

function cmdCheck(options) {
  const encryptionKey = getEncryptionKey(options.key);
  const usersDir = path.join(DATA_DIR, "users");
  if (!fs.existsSync(usersDir)) {
    console.log("无数据可检查");
    return;
  }

  console.log("\n=== 一致性检查 ===\n");
  let issues = 0;

  for (const userId of fs.readdirSync(usersDir)) {
    const userDir = path.join(usersDir, userId);
    if (!fs.statSync(userDir).isDirectory()) continue;

    const accountsDir = path.join(userDir, "accounts");
    if (!fs.existsSync(accountsDir)) {
      console.log(`⚠ 用户 ${userId} 无 accounts 目录`);
      issues++;
      continue;
    }

    for (const accountId of fs.readdirSync(accountsDir)) {
      const accountDir = path.join(accountsDir, accountId);
      if (!fs.statSync(accountDir).isDirectory()) continue;

      const keysDir = path.join(accountDir, "keys");
      if (!fs.existsSync(keysDir) || fs.readdirSync(keysDir).length === 0) {
        console.log(`⚠ 孤立账户: ${accountId} (无 key)`);
        issues++;
        continue;
      }

      for (const keyId of fs.readdirSync(keysDir)) {
        const keyDir = path.join(keysDir, keyId);
        if (!fs.statSync(keyDir).isDirectory()) continue;

        // 检查缺失 session
        const sessionFile = path.join(keyDir, "session.json");
        if (!fs.existsSync(sessionFile)) {
          console.log(`⚠ 缺失 session: key ${keyId}`);
          issues++;
          continue;
        }

        // 检查过期 session
        try {
          const session = loadJson(sessionFile, encryptionKey);
          if (session.expiresAt) {
            const expires = new Date(session.expiresAt).getTime();
            if (!Number.isNaN(expires) && expires <= Date.now()) {
              console.log(`⚠ 过期 session: key ${keyId} (expiresAt: ${session.expiresAt})`);
              issues++;
            }
          }
        } catch {
          console.log(`⚠ 无法读取 session: key ${keyId}`);
          issues++;
        }

        // 检查已撤销 key
        try {
          const key = loadJson(path.join(keyDir, "key.json"), encryptionKey);
          if (key.revokedAt) {
            console.log(`ℹ 已撤销 key: ${keyId} (revokedAt: ${key.revokedAt})`);
          }
        } catch {
          // ignore
        }
      }
    }
  }

  if (issues === 0) {
    console.log("✓ 数据一致，无问题\n");
  } else {
    console.log(`\n发现 ${issues} 个问题\n`);
  }
}

function cmdMigrate(extraArgs) {
  const scriptPath = path.resolve(__dirname, "data-migrate.mjs");
  const args = extraArgs.join(" ");
  execSync(`node "${scriptPath}" ${args}`, { stdio: "inherit" });
}

function cmdRekey(options) {
  if (!options.oldKey || !options.newKey) {
    console.error("错误：rekey 需要 --old 和 --new 参数");
    process.exit(1);
  }

  const oldKey = getEncryptionKey(options.oldKey);
  const newKey = getEncryptionKey(options.newKey);

  console.log("\n=== 重加密所有文件 ===\n");
  let count = 0;

  function rewalk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, name);
      if (fs.statSync(fullPath).isDirectory()) {
        rewalk(fullPath);
        continue;
      }
      if (!name.endsWith(".json")) continue;

      try {
        const data = loadJson(fullPath, oldKey);
        writeEncryptedJson(fullPath, data, newKey);
        // 验证
        loadJson(fullPath, newKey);
        console.log(`  ✓ ${path.relative(DATA_DIR, fullPath)}`);
        count++;
      } catch (e) {
        console.error(`  ✗ ${path.relative(DATA_DIR, fullPath)}: ${e.message}`);
      }
    }
  }

  rewalk(path.join(DATA_DIR, "users"));
  console.log(`\n✓ 重加密完成: ${count} 个文件\n`);
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { mask: true, key: null, oldKey: null, newKey: null };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--key" && args[i + 1]) { options.key = args[++i]; }
    else if (arg === "--old" && args[i + 1]) { options.oldKey = args[++i]; }
    else if (arg === "--new" && args[i + 1]) { options.newKey = args[++i]; }
    else if (arg === "--no-mask") { options.mask = false; }
    else if (!arg.startsWith("--")) { positional.push(arg); }
  }

  return { command: positional[0], args: positional.slice(1), options };
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

function main() {
  const { command, args, options } = parseArgs();

  if (!command) {
    console.log(`
data-manager.mjs — 分层目录存储的数据管理 CLI

用法：
  node scripts/data-manager.mjs list                          列出所有实体
  node scripts/data-manager.mjs show <type> <id>              查看实体（掩码）
  node scripts/data-manager.mjs reveal <type> <id>            完整显示（不掩码）
  node scripts/data-manager.mjs tree                          ASCII 树形展示
  node scripts/data-manager.mjs export <type> <id> [output]   导出为明文 JSON
  node scripts/data-manager.mjs check                         一致性检查
  node scripts/data-manager.mjs migrate [--dry-run]           调用迁移
  node scripts/data-manager.mjs rekey --old <k> --new <k>     重加密

类型: user, account, key, session
选项: --key <key>, --no-mask
`);
    process.exit(0);
  }

  switch (command) {
    case "list":
      cmdList();
      break;
    case "show":
      if (args.length < 2) { console.error("用法: show <type> <id>"); process.exit(1); }
      cmdShow(args[0], args[1], options);
      break;
    case "reveal":
      if (args.length < 2) { console.error("用法: reveal <type> <id>"); process.exit(1); }
      cmdReveal(args[0], args[1], options);
      break;
    case "tree":
      cmdTree();
      break;
    case "export":
      if (args.length < 2) { console.error("用法: export <type> <id> [output]"); process.exit(1); }
      cmdExport(args[0], args[1], args[2], options);
      break;
    case "check":
      cmdCheck(options);
      break;
    case "migrate":
      cmdMigrate(args);
      break;
    case "rekey":
      cmdRekey(options);
      break;
    default:
      console.error(`未知命令: ${command}`);
      process.exit(1);
  }
}

main();
