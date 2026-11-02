/**
 * 鉴权作用域分流测试（add-account-routing 任务 2.9）。
 *
 * API Key 认证接受用户级 Key（走聚合分支）；
 * Web UI 的 Cookie 认证只接受账号级 Key。
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import type { Request, Response } from "express";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "auth-scope-test-"));
process.env.DATA_DIR = TMP_DIR;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const keyStore = require("../store/api-key-store") as typeof import("../store/api-key-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require("../store/hierarchical-store") as typeof import("../store/hierarchical-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const encryption = require("../auth/crypto/encryption") as typeof import("../auth/crypto/encryption");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const uiAuth = require("./authenticate-ui") as typeof import("./authenticate-ui");

const NOW = "2026-01-01T00:00:00.000Z";
const USER_ID = "user-scope";

store.setUser({ id: USER_ID, displayName: "tester", createdAt: NOW, updatedAt: NOW });
store.setProviderAccount({
  id: "acc-A",
  userId: USER_ID,
  provider: "huawei-codearts",
  displayName: "account A",
  isDefault: true,
  status: "active",
  createdAt: NOW,
  updatedAt: NOW,
});

const accountKey = keyStore.issueApiKey({
  userId: USER_ID,
  providerAccountId: "acc-A",
  name: "account-scoped",
  rawKey: "sk-scope-account",
});
store.setSession(accountKey.id, {
  keyId: accountKey.id,
  providerAccountId: "acc-A",
  accessKey: "AK",
  secretKeyCiphertext: "cipher",
  securityToken: "token",
});

keyStore.issueApiKey({
  userId: USER_ID,
  scope: "user",
  name: "user-scoped",
  rawKey: "sk-scope-user",
});

function makeReq(rawKey: string): Request {
  return {
    cookies: { auth_key: encryption.encryptString(rawKey) },
  } as unknown as Request;
}

function makeRes(): { res: Response; wasRedirected: () => boolean } {
  let redirected = false;
  const res = {
    redirect: () => {
      redirected = true;
    },
  } as unknown as Response;
  return { res, wasRedirected: () => redirected };
}

// ---------------------------------------------------------------------------
// API Key 认证：接受用户级 Key
// ---------------------------------------------------------------------------

function testApiKeyAuthAcceptsUserScopedKey(): void {
  const auth = keyStore.validateApiKey("sk-scope-user");
  assert.ok(auth, "用户级 Key 应能通过 API Key 认证");
  assert.equal(auth?.kind, "aggregate");
}

// ---------------------------------------------------------------------------
// Web UI Cookie 认证：只接受账号级 Key
// ---------------------------------------------------------------------------

function testUiAuthAcceptsAccountScopedKey(): void {
  const { res, wasRedirected } = makeRes();
  let nextCalled = false;
  uiAuth.requireUiAuth(makeReq("sk-scope-account"), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true, "账号级 Key 应能通过 UI Cookie 认证");
  assert.equal(wasRedirected(), false);
}

function testUiAuthRejectsUserScopedKey(): void {
  const { res, wasRedirected } = makeRes();
  let nextCalled = false;
  uiAuth.requireUiAuth(makeReq("sk-scope-user"), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false, "用户级 Key 不应能通过 UI Cookie 认证");
  assert.equal(wasRedirected(), true, "用户级 Key 应被重定向到登录页");
}

try {
  testApiKeyAuthAcceptsUserScopedKey();
  testUiAuthAcceptsAccountScopedKey();
  testUiAuthRejectsUserScopedKey();
  console.log("All auth scope tests passed.");
} finally {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}
