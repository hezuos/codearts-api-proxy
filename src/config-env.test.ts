/**
 * config.ts .env 加载集成测试。
 *
 * Style aligned with chat.test.ts: plain assert + manual run, no test framework.
 * config 是模块级单例，.env 注入发生在模块加载时，
 * 因此用子进程隔离验证（子进程内 require config，校验 .env 变量已注入 process.env）。
 */
import assert from "assert";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const TS_NODE_BIN = require.resolve("ts-node/register");

function runInChild(envFile: string, probeVar: string): string {
  const script = `
    require(${JSON.stringify(TS_NODE_BIN)});
    require("./src/config");
    process.stdout.write(JSON.stringify({ probe: process.env[${JSON.stringify(probeVar)}] }));
  `;
  return execFileSync(
    process.execPath,
    ["-e", script],
    {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, ENV_FILE: envFile },
      encoding: "utf8",
    },
  );
}

function testEnvFileInjected(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-env-test-"));
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "CONFIG_ENV_TEST_PROBE=from-file\n");
  try {
    const out = runInChild(envFile, "CONFIG_ENV_TEST_PROBE");
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.probe, "from-file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ .env injected into process.env via config load");
}

/** 在子进程中加载 config 并返回指定字段的 JSON 快照。 */
function readConfigInChild(envFile: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const script = `
    require(${JSON.stringify(TS_NODE_BIN)});
    const { config, getChatUrl } = require("./src/config");
    process.stdout.write(JSON.stringify({
      huaweiV2ChatPath: config.huaweiV2ChatPath,
      chatUrl: getChatUrl(),
    }));
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, ENV_FILE: envFile };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const out = execFileSync(process.execPath, ["-e", script], {
    cwd: path.resolve(__dirname, ".."),
    env,
    encoding: "utf8",
  });
  return JSON.parse(out);
}

function testV2ChatPathDefault(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-v2-test-"));
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "");
  try {
    // 不设置 HUAWEI_V2_CHAT_PATH，验证默认值。
    const parsed = readConfigInChild(envFile, { HUAWEI_V2_CHAT_PATH: undefined as unknown as string });
    assert.strictEqual(
      parsed.huaweiV2ChatPath,
      "/api/v2/chat/completions",
      "default huaweiV2ChatPath should be /api/v2/chat/completions",
    );
    assert.ok(
      String(parsed.chatUrl).endsWith("/api/v2/chat/completions"),
      `getChatUrl() should end with the v2 path; got: ${parsed.chatUrl}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ HUAWEI_V2_CHAT_PATH default is /api/v2/chat/completions");
}

function testV2ChatPathOverride(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-v2-override-"));
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "");
  try {
    const parsed = readConfigInChild(envFile, {
      HUAWEI_V2_CHAT_PATH: "/custom/v2/path",
      HUAWEI_CHAT_HOST: "https://example.test",
    });
    assert.strictEqual(parsed.huaweiV2ChatPath, "/custom/v2/path");
    assert.strictEqual(parsed.chatUrl, "https://example.test/custom/v2/path");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ HUAWEI_V2_CHAT_PATH override is honored by getChatUrl()");
}

testEnvFileInjected();
testV2ChatPathDefault();
testV2ChatPathOverride();
console.log("config-env.test.ts passed");
