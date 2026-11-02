/**
 * 跨账号迁移循环测试（add-account-routing 组 4）。
 *
 * 覆盖：撞限后换账号、原账号进入冷却、每账号至多一次、凭证失效先刷新再迁移、
 * 模型不可用可迁移、迁移发生在同账号重试耗尽之后、并发错误映射 429。
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "migration-test-"));
process.env.DATA_DIR = TMP_DIR;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require("../store/hierarchical-store") as typeof import("../store/hierarchical-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const keyStore = require("../store/api-key-store") as typeof import("../store/api-key-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const selector = require("./account-selector") as typeof import("./account-selector");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const router = require("./request-router") as typeof import("./request-router");
import { runMigrationLoop } from "./migration-loop";
import {
  UpstreamAuthError,
  UpstreamConcurrencyError,
  UpstreamServerError,
} from "../utils/errors";
import { sendErrorResponse } from "../routes/openai";
import type { RouteTarget } from "./request-router";

const NOW = "2026-01-01T00:00:00.000Z";
const USER_ID = "user-migration";

function setupAccount(accountId: string): void {
  store.setProviderAccount({
    id: accountId,
    userId: USER_ID,
    provider: "huawei-codearts",
    displayName: "account " + accountId,
    isDefault: false,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const key = keyStore.issueApiKey({
    userId: USER_ID,
    providerAccountId: accountId,
    name: "key-" + accountId,
    rawKey: "sk-" + accountId,
  });
  store.setSession(key.id, {
    keyId: key.id,
    providerAccountId: accountId,
    accessKey: "AK-" + accountId,
    secretKeyCiphertext: "cipher",
    securityToken: "token",
  });
}

store.setUser({
  id: USER_ID,
  displayName: "tester",
  createdAt: NOW,
  updatedAt: NOW,
});
setupAccount("acc-A");
setupAccount("acc-B");
setupAccount("acc-C");

keyStore.issueApiKey({
  userId: USER_ID,
  scope: "user",
  balancingPolicy: "request",
  name: "user-scoped",
  rawKey: "sk-user-migration",
});

const userAuth = keyStore.validateApiKey("sk-user-migration");
assert.ok(userAuth, "前置条件：用户级 Key 可认证");
assert.equal(userAuth?.kind, "aggregate");

function resetRoutingState(): void {
  selector.__testHooks.reset();
}

/** 构造一个响应对象桩，捕获状态码与响应头。 */
function makeRes(): {
  res: import("express").Response;
  statusCode: () => number;
  header: (name: string) => unknown;
} {
  const state = { statusCode: 0, headers: new Map<string, unknown>() };
  const res = {
    headersSent: false,
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json() {
      return res;
    },
    setHeader(name: string, value: unknown) {
      state.headers.set(name, value);
      return res;
    },
  } as unknown as import("express").Response;
  return {
    res,
    statusCode: () => state.statusCode,
    header: (name: string) => state.headers.get(name),
  };
}

// ---------------------------------------------------------------------------
// 4.5 错误分类
// ---------------------------------------------------------------------------

function testErrorClassification(): void {
  assert.equal(
    router.classifyMigrationCause(new UpstreamConcurrencyError("x", 100)),
    "concurrency",
  );
  assert.equal(
    router.classifyMigrationCause(new UpstreamAuthError(401, "denied")),
    "credential",
  );
  assert.equal(
    router.classifyMigrationCause(
      new UpstreamServerError(400, "model glm-5.3 is not available"),
    ),
    "model",
    "模型不可用 SHALL 归类为可迁移错误",
  );
  assert.equal(
    router.classifyMigrationCause(new Error("network down")),
    null,
    "普通错误不迁移",
  );
}

// ---------------------------------------------------------------------------
// 4.2 撞限后换账号 + 原账号进入冷却
// ---------------------------------------------------------------------------

async function testMigratesAfterConcurrencyFailure(): Promise<void> {
  resetRoutingState();
  const calls: string[] = [];
  const migrations: string[] = [];
  let finalError: unknown = null;

  await runMigrationLoop({
    auth: userAuth!,
    conversationId: "conv-mig-1",
    signal: new AbortController().signal,
    attempt: async (target: RouteTarget) => {
      calls.push(target.accountId);
      if (target.accountId === "acc-A") {
        throw new UpstreamConcurrencyError("upstream limit", 1000);
      }
    },
    responseStarted: () => false,
    onFinalError: (error) => {
      finalError = error;
    },
    onMigrate: (info) => migrations.push(info.fromAccountId),
  });

  assert.equal(calls.length, 2, "应在第二个账号上重试一次");
  assert.equal(calls[0], "acc-A", "首次应选 acc-A");
  assert.notEqual(calls[1], "acc-A", "第二次 SHALL 使用另一账号");
  assert.ok(
    calls[1] === "acc-B" || calls[1] === "acc-C",
    "第二次 SHALL 落在剩余候选账号上",
  );
  assert.equal(finalError, null, "第二个账号成功时不应有最终错误");
  assert.deepEqual(migrations, ["acc-A"], "应记录一次迁移");
  assert.equal(
    selector.isAccountCoolingDown("acc-A"),
    true,
    "原账号 SHALL 进入冷却",
  );
  assert.equal(
    selector.isAccountCoolingDown("acc-B"),
    false,
    "新账号不应进入冷却",
  );
}

// ---------------------------------------------------------------------------
// 4.3 每个账号至多尝试一次
// ---------------------------------------------------------------------------

async function testEachAccountAttemptedAtMostOnce(): Promise<void> {
  resetRoutingState();
  const calls: string[] = [];
  let finalError: unknown = null;

  await runMigrationLoop({
    auth: userAuth!,
    conversationId: "conv-mig-2",
    signal: new AbortController().signal,
    attempt: async (target: RouteTarget) => {
      calls.push(target.accountId);
      throw new UpstreamConcurrencyError("upstream limit", 1000);
    },
    responseStarted: () => false,
    onFinalError: (error) => {
      finalError = error;
    },
  });

  assert.equal(calls.length, 3, "三个账号各尝试一次");
  assert.equal(new Set(calls).size, 3, "同一账号 SHALL NOT 被重复尝试");
  assert.ok(
    finalError instanceof UpstreamConcurrencyError,
    "全部账号失败时 SHALL 上报并发错误（→429）",
  );
}

// ---------------------------------------------------------------------------
// 4.6 迁移发生在同账号重试耗尽之后
// ---------------------------------------------------------------------------

async function testMigrationHappensAfterSameAccountRetries(): Promise<void> {
  resetRoutingState();
  const sequence: string[] = [];

  await runMigrationLoop({
    auth: userAuth!,
    conversationId: "conv-mig-3",
    signal: new AbortController().signal,
    attempt: async (target: RouteTarget) => {
      sequence.push("attempt:" + target.accountId);
      if (target.accountId === "acc-A") {
        // 模拟上游层同账号退避重试：重试耗尽后才抛出
        for (let i = 0; i < 3; i++) {
          sequence.push("same-account-retry:" + target.accountId + ":" + i);
        }
        throw new UpstreamConcurrencyError("upstream limit", 1000);
      }
    },
    responseStarted: () => false,
    onFinalError: () => undefined,
  });

  const firstOtherAccount = sequence.findIndex(
    (s) => s.startsWith("attempt:acc-") && s !== "attempt:acc-A",
  );
  const lastSameAccountRetry = sequence.reduce(
    (last, s, i) => (s.startsWith("same-account-retry:") ? i : last),
    -1,
  );
  assert.ok(lastSameAccountRetry >= 0, "应记录同账号重试");
  assert.ok(
    firstOtherAccount > lastSameAccountRetry,
    "切换账号 SHALL 发生在同账号重试耗尽之后",
  );
}

// ---------------------------------------------------------------------------
// 4.2 凭证失效：先刷新同一账号，刷新后仍失败才迁移
// ---------------------------------------------------------------------------

async function testCredentialFailureRefreshesBeforeMigrating(): Promise<void> {
  resetRoutingState();
  const calls: string[] = [];
  const refreshes: string[] = [];

  await runMigrationLoop({
    auth: userAuth!,
    conversationId: "conv-mig-4",
    signal: new AbortController().signal,
    attempt: async (target: RouteTarget) => {
      calls.push(target.accountId);
      if (target.accountId === "acc-A") {
        throw new UpstreamAuthError(401, "denied");
      }
    },
    refresh: async (target: RouteTarget) => {
      refreshes.push(target.accountId);
      // 刷新成功，但凭据仍被拒——此时才应迁移
      return target.session;
    },
    responseStarted: () => false,
    onFinalError: () => undefined,
  });

  assert.deepEqual(refreshes, ["acc-A"], "SHALL 先刷新失败账号的凭据");
  assert.equal(calls[0], "acc-A");
  assert.equal(calls[1], "acc-A", "刷新后 SHALL 先重试同一账号");
  assert.notEqual(calls[2], "acc-A", "刷新后仍失败才换账号");
  assert.ok(
    calls[2] === "acc-B" || calls[2] === "acc-C",
    "迁移 SHALL 落在剩余候选账号上",
  );
}

// ---------------------------------------------------------------------------
// 4.5 模型不可用 → 换账号后成功
// ---------------------------------------------------------------------------

async function testModelUnavailableMigratesToAnotherAccount(): Promise<void> {
  resetRoutingState();
  const calls: string[] = [];
  let finalError: unknown = null;

  await runMigrationLoop({
    auth: userAuth!,
    conversationId: "conv-mig-7",
    signal: new AbortController().signal,
    attempt: async (target: RouteTarget) => {
      calls.push(target.accountId);
      if (target.accountId === "acc-A") {
        throw new UpstreamServerError(
          400,
          "model glm-5.3 is not available for this account",
        );
      }
    },
    responseStarted: () => false,
    onFinalError: (error) => {
      finalError = error;
    },
  });

  assert.equal(calls.length, 2, "模型不可用 SHALL 触发换账号");
  assert.notEqual(calls[1], "acc-A", "SHALL 改用另一账号");
  assert.equal(finalError, null, "另一账号可用时 SHALL 成功");
  assert.equal(
    selector.isAccountCoolingDown("acc-A"),
    true,
    "模型不可用的账号 SHALL 进入冷却",
  );
}

// ---------------------------------------------------------------------------
// 4.4 / 429 映射
// ---------------------------------------------------------------------------

function testConcurrencyErrorMapsTo429(): void {
  const { res, statusCode, header } = makeRes();
  sendErrorResponse(res, new UpstreamConcurrencyError("limit", 30_000));
  assert.equal(statusCode(), 429, "并发受限 SHALL 映射为 429");
  assert.equal(header("Retry-After"), "30", "SHALL 携带 Retry-After 提示");
}

async function testAllAccountsUnavailableReturnsLastConcurrencyError(): Promise<void> {
  resetRoutingState();
  let finalError: unknown = null;

  await runMigrationLoop({
    auth: userAuth!,
    conversationId: "conv-mig-5",
    signal: new AbortController().signal,
    attempt: async () => {
      throw new UpstreamConcurrencyError("upstream limit", 1000);
    },
    responseStarted: () => false,
    onFinalError: (error) => {
      finalError = error;
    },
  });

  assert.ok(
    finalError instanceof UpstreamConcurrencyError,
    "全部账号不可用时 SHALL 保留并发错误语义（→429）",
  );
}

// ---------------------------------------------------------------------------
// 响应已开始下发时不得迁移
// ---------------------------------------------------------------------------

async function testNoMigrationAfterResponseStarted(): Promise<void> {
  resetRoutingState();
  const calls: string[] = [];

  await runMigrationLoop({
    auth: userAuth!,
    conversationId: "conv-mig-6",
    signal: new AbortController().signal,
    attempt: async (target: RouteTarget) => {
      calls.push(target.accountId);
      throw new UpstreamConcurrencyError("upstream limit", 1000);
    },
    responseStarted: () => true,
    onFinalError: () => undefined,
  });

  assert.equal(calls.length, 1, "响应已开始下发时 SHALL NOT 迁移");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  testErrorClassification();
  await testMigratesAfterConcurrencyFailure();
  await testEachAccountAttemptedAtMostOnce();
  await testMigrationHappensAfterSameAccountRetries();
  await testCredentialFailureRefreshesBeforeMigrating();
  await testModelUnavailableMigratesToAnotherAccount();
  testConcurrencyErrorMapsTo429();
  await testAllAccountsUnavailableReturnsLastConcurrencyError();
  await testNoMigrationAfterResponseStarted();
  console.log("All migration loop tests passed.");
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

void main();
