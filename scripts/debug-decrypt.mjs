#!/usr/bin/env node
/**
 * @deprecated Use data-manager.mjs instead. This script targets the old flat-file format.
 *
 * debug-decrypt.mjs — 解密项目加密存储文件的调试工具
 *
 * 用法：
 *   node scripts/debug-decrypt.mjs <command> [options]
 *
 * 命令：
 *   list                    列出所有加密文件及其状态
 *   show <file>             显示文件内容（敏感信息掩码）
 *   reveal <file>           显示完整内容（包含敏感信息）
 *   export <file> [output]  导出为明文 JSON
 *
 * 选项：
 *   --key <key>             使用自定义加密密钥
 *   --pretty                格式化 JSON 输出（默认启用）
 *   --no-mask               不掩码敏感字段
 *
 * 示例：
 *   node scripts/debug-decrypt.mjs list
 *   node scripts/debug-decrypt.mjs show auth-store
 *   node scripts/debug-decrypt.mjs reveal huawei-sessions
 *   node scripts/debug-decrypt.mjs export huawei-sessions ./debug-sessions.json
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const DATA_DIR = path.resolve(__dirname, "..", "data");

const FILE_MAP = {
  "auth-store": "auth-store.json",
  "huawei-sessions": "huawei-sessions.json",
  "admin-config": "admin-config.json",
  "conversation-store": "conversation-store.json",
};

const SENSITIVE_FIELDS = new Set([
  "secretKey",
  "secretKeyCiphertext",
  "secret",
  "securityToken",
  "securitytoken",
  "passwordHash",
  "keyHash",
  "businessToken",
  "cloudDragonToken",
  "accessToken",
]);

// ---------------------------------------------------------------------------
// 加密/解密
// ---------------------------------------------------------------------------

function getEncryptionKey(customKey) {
  const key =
    customKey ||
    process.env.ENCRYPTION_KEY ||
    "dev-only-32-byte-encryption-key!";
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
  } catch (error) {
    // 可能不是加密数据，返回原文
    return cipherText;
  }
}

function isEncrypted(content) {
  // 尝试解析为 JSON，如果失败则可能是加密的
  try {
    JSON.parse(content);
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// 敏感信息掩码
// ---------------------------------------------------------------------------

function maskValue(value, depth = 0) {
  if (depth > 10) return value;
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (value.length <= 8) {
      return `**** (${value.length} chars)`;
    }
    return `${value.slice(0, 4)}...${value.slice(-4)} (${value.length} chars)`;
  }

  if (Array.isArray(value)) {
    return value.map((v) => maskValue(v, depth + 1));
  }

  if (typeof value === "object") {
    const masked = {};
    for (const [k, v] of Object.entries(value)) {
      masked[k] = maskValue(v, depth + 1);
    }
    return masked;
  }

  return value;
}

function maskSensitive(obj, shouldMask = true) {
  if (!shouldMask) return obj;
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => maskSensitive(item, shouldMask));
  }

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
// 文件操作
// ---------------------------------------------------------------------------

function resolveFilePath(fileArg) {
  // 检查是否是别名
  if (FILE_MAP[fileArg]) {
    return path.join(DATA_DIR, FILE_MAP[fileArg]);
  }

  // 检查是否是相对路径
  if (fileArg.includes("/") || fileArg.includes("\\")) {
    return path.resolve(fileArg);
  }

  // 尝试作为 data 目录下的文件名
  const directPath = path.join(DATA_DIR, fileArg);
  if (fs.existsSync(directPath)) {
    return directPath;
  }

  // 尝试添加 .json 后缀
  const jsonPath = path.join(DATA_DIR, `${fileArg}.json`);
  if (fs.existsSync(jsonPath)) {
    return jsonPath;
  }

  return null;
}

function loadAndDecrypt(filePath, encryptionKey) {
  const content = fs.readFileSync(filePath, "utf8");

  if (isEncrypted(content)) {
    const decrypted = decryptString(content, encryptionKey);
    return JSON.parse(decrypted);
  }

  return JSON.parse(content);
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

function cmdList() {
  console.log("\n加密文件列表：\n");
  console.log("别名                文件路径                        状态");
  console.log("─".repeat(70));

  for (const [alias, filename] of Object.entries(FILE_MAP)) {
    const filePath = path.join(DATA_DIR, filename);
    const exists = fs.existsSync(filePath);
    const status = exists ? "✓ 存在" : "✗ 不存在";

    let size = "";
    let encrypted = "";
    if (exists) {
      const stat = fs.statSync(filePath);
      size = `(${(stat.size / 1024).toFixed(1)} KB)`;
      const content = fs.readFileSync(filePath, "utf8");
      encrypted = isEncrypted(content) ? "[加密]" : "[明文]";
    }

    console.log(
      `${alias.padEnd(20)} ${filename.padEnd(30)} ${status} ${size} ${encrypted}`,
    );
  }

  console.log("\n提示：使用 'show <别名>' 查看内容\n");
}

function cmdShow(fileArg, options) {
  const filePath = resolveFilePath(fileArg);
  if (!filePath || !fs.existsSync(filePath)) {
    console.error(`错误：文件不存在 - ${fileArg}`);
    console.error("可用别名：", Object.keys(FILE_MAP).join(", "));
    process.exit(1);
  }

  const encryptionKey = getEncryptionKey(options.key);

  console.log(`\n文件：${filePath}\n`);

  try {
    const data = loadAndDecrypt(filePath, encryptionKey);
    const display = maskSensitive(data, options.mask);

    console.log(JSON.stringify(display, null, 2));
  } catch (error) {
    console.error("解密或解析失败：", error.message);
    process.exit(1);
  }
}

function cmdReveal(fileArg, options) {
  const filePath = resolveFilePath(fileArg);
  if (!filePath || !fs.existsSync(filePath)) {
    console.error(`错误：文件不存在 - ${fileArg}`);
    process.exit(1);
  }

  const encryptionKey = getEncryptionKey(options.key);

  console.log(`\n文件：${filePath}\n`);
  console.warn("⚠️  警告：显示完整内容，包含敏感信息！\n");

  try {
    const data = loadAndDecrypt(filePath, encryptionKey);
    console.log(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("解密或解析失败：", error.message);
    process.exit(1);
  }
}

function cmdExport(fileArg, outputPath, options) {
  const filePath = resolveFilePath(fileArg);
  if (!filePath || !fs.existsSync(filePath)) {
    console.error(`错误：文件不存在 - ${fileArg}`);
    process.exit(1);
  }

  const encryptionKey = getEncryptionKey(options.key);
  const outPath = outputPath || `./${path.basename(filePath)}-decrypted.json`;

  try {
    const data = loadAndDecrypt(filePath, encryptionKey);
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`\n✓ 已导出到：${outPath}\n`);

    // 显示摘要
    if (data.version) console.log(`  版本：${data.version}`);
    if (data.users) console.log(`  用户数：${data.users.length}`);
    if (data.sessions) console.log(`  会话数：${data.sessions.length}`);
    if (data.apiKeys) console.log(`  API Key 数：${data.apiKeys.length}`);
    if (data.providerAccounts)
      console.log(`  Provider Account 数：${data.providerAccounts.length}`);
  } catch (error) {
    console.error("导出失败：", error.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    mask: true,
    pretty: true,
    key: null,
  };

  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--key" && args[i + 1]) {
      options.key = args[i + 1];
      i++;
    } else if (arg === "--no-mask") {
      options.mask = false;
    } else if (arg === "--pretty") {
      options.pretty = true;
    } else if (arg.startsWith("--")) {
      // 忽略未知选项
    } else {
      positional.push(arg);
    }
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
debug-decrypt.mjs — 解密项目加密存储文件的调试工具

用法：
  node scripts/debug-decrypt.mjs <command> [options]

命令：
  list                    列出所有加密文件及其状态
  show <file>             显示文件内容（敏感信息掩码）
  reveal <file>           显示完整内容（包含敏感信息）
  export <file> [output]  导出为明文 JSON

选项：
  --key <key>             使用自定义加密密钥
  --no-mask               不掩码敏感字段

示例：
  node scripts/debug-decrypt.mjs list
  node scripts/debug-decrypt.mjs show auth-store
  node scripts/debug-decrypt.mjs reveal huawei-sessions
  node scripts/debug-decrypt.mjs export huawei-sessions ./debug-sessions.json
`);
    process.exit(0);
  }

  switch (command) {
    case "list":
      cmdList();
      break;
    case "show":
      if (!args[0]) {
        console.error("错误：缺少文件参数");
        console.error("用法：show <file>");
        process.exit(1);
      }
      cmdShow(args[0], options);
      break;
    case "reveal":
      if (!args[0]) {
        console.error("错误：缺少文件参数");
        console.error("用法：reveal <file>");
        process.exit(1);
      }
      cmdReveal(args[0], options);
      break;
    case "export":
      if (!args[0]) {
        console.error("错误：缺少文件参数");
        console.error("用法：export <file> [output]");
        process.exit(1);
      }
      cmdExport(args[0], args[1], options);
      break;
    default:
      console.error(`错误：未知命令 '${command}'`);
      console.error("可用命令：list, show, reveal, export");
      process.exit(1);
  }
}

main();
