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

testEnvFileInjected();
console.log("config-env.test.ts passed");
