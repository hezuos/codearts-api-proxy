/**
 * 分层存储测试（add-account-routing 组 2）。
 *
 * 覆盖作用域分支、复合寻址、用户级 Key 存储路径、级联删除与吊销持久化。
 *
 * config 是模块级单例，因此 DATA_DIR 必须在加载 store 之前设置；
 * 本文件作为独立进程运行（pnpm test 逐文件串联）。
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "store-test-"));
process.env.DATA_DIR = TMP_DIR;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require("./hierarchical-store") as typeof import("./hierarchical-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const keyStore = require("./api-key-store") as typeof import("./api-key-store");

const NOW = "2026-01-01T00:00:00.000Z";
const USER_ID = "user-1";

function setupAccount(id: string, isDefault = false): void {
  store.setProviderAccount({
    id,
    userId: USER_ID,
    provider: "huawei-codearts",
    displayName: `account ${id}`,
    isDefault,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function setupUser(): void {
  store.setUser({
    id: USER_ID,
    displayName: "tester",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeSession(keyId: string, accountId: string): void {
  store.setSession(keyId, {
    keyId,
    providerAccountId: accountId,
    accessKey: `AK-${accountId}`,
    secretKeyCiphertext: "cipher",
    securityToken: "token",
  });
}

// ---------------------------------------------------------------------------
// 2.1 Key 模型：旧数据语义不变
// ---------------------------------------------------------------------------

function testLegacyKeySemanticsUnchanged(): void {
  setupUser();
  setupAccount("acc-A", true);

  const key = keyStore.issueApiKey({
    userId: USER_ID,
    providerAccountId: "acc-A",
    name: "legacy",
    rawKey: "sk-legacy",
  });

  assert.equal(store.resolveKeyScope(key), "account", "旧 Key 缺省按账号级解释");
  assert.equal(keyStore.resolveBalancingPolicy(key), "conversation", "旧 Key 缺省按对话连续解释");
  assert.deepEqual(
    store.resolveBoundAccountIds(key),
    ["acc-A"],
    "旧 Key 的绑定账号取首选账号",
  );
}

// ---------------------------------------------------------------------------
// 2.2 会话按 (Key, Account) 复合寻址
// ---------------------------------------------------------------------------

function testOneKeyTwoAccountsHaveOwnSessions(): void {
  setupAccount("acc-B");

  const key = keyStore.issueApiKey({
    userId: USER_ID,
    providerAccountId: "acc-A",
    providerAccountIds: ["acc-A", "acc-B"],
    name: "multi",
    rawKey: "sk-multi",
  });

  makeSession(key.id, "acc-A");
  makeSession(key.id, "acc-B");

  const sessionA = store.getSession(key.id, "acc-A");
  const sessionB = store.getSession(key.id, "acc-B");

  assert.equal(sessionA?.accessKey, "AK-acc-A");
  assert.equal(sessionB?.accessKey, "AK-acc-B");
  assert.notEqual(sessionA, sessionB, "两个账号的会话互不相同");

  // 首选账号的会话仍可通过兼容接口取到
  assert.equal(store.getSessionByKeyId(key.id)?.accessKey, "AK-acc-A");
}

// ---------------------------------------------------------------------------
// 2.3 鉴权上下文：判别联合
// ---------------------------------------------------------------------------

function testAuthContextBranches(): void {
  const accountKey = keyStore.issueApiKey({
    userId: USER_ID,
    providerAccountId: "acc-A",
    name: "acct",
    rawKey: "sk-acct",
  });
  makeSession(accountKey.id, "acc-A");

  const userKey = keyStore.issueApiKey({
    userId: USER_ID,
    scope: "user",
    balancingPolicy: "request",
    name: "user-scoped",
    rawKey: "sk-user",
  });
  assert.ok(userKey.id);

  const accountAuth = keyStore.validateApiKey("sk-acct");
  assert.equal(accountAuth?.kind, "account", "账号级 Key 走账号分支");
  if (accountAuth?.kind === "account") {
    assert.equal(accountAuth.providerAccountId, "acc-A");
    assert.ok(accountAuth.session);
  }

  const userAuth = keyStore.validateApiKey("sk-user");
  assert.equal(userAuth?.kind, "aggregate", "用户级 Key 走聚合分支");
  if (userAuth?.kind === "aggregate") {
    assert.equal(userAuth.balancingPolicy, "request");
    assert.equal((userAuth as { session?: unknown }).session, undefined, "聚合分支不携带会话");
  }
}

// ---------------------------------------------------------------------------
// 2.4 位置索引显式携带作用域
// ---------------------------------------------------------------------------

function testKeyLocationCarriesScope(): void {
  const userKey = keyStore.issueApiKey({
    userId: USER_ID,
    scope: "user",
    name: "user-scoped-2",
    rawKey: "sk-user-2",
  });
  const accountKey = keyStore.issueApiKey({
    userId: USER_ID,
    providerAccountId: "acc-A",
    name: "acct-2",
    rawKey: "sk-acct-2",
  });

  assert.equal(store.getKeyLocation(userKey.id)?.scope, "user");
  assert.equal(store.getKeyLocation(accountKey.id)?.scope, "account");
}

// ---------------------------------------------------------------------------
// 2.5 用户级 Key 存储路径 + 吊销持久化
// ---------------------------------------------------------------------------

function testUserScopedKeyPathAndReload(): void {
  const userKey = keyStore.issueApiKey({
    userId: USER_ID,
    scope: "user",
    name: "persist",
    rawKey: "sk-persist",
  });

  const keyFile = path.join(TMP_DIR, "users", USER_ID, "keys", userKey.id, "key.json");
  assert.ok(fs.existsSync(keyFile), "用户级 Key 应落在 users/{userId}/keys/{keyId}/key.json");

  const keyDir = path.dirname(keyFile);
  assert.ok(
    !fs.existsSync(path.join(keyDir, "session.json")),
    "用户级 Key 不应持有自有会话文件",
  );

  // 重新加载（模拟重启）
  store.loadAllEntities();
  const reloaded = store.getApiKey(userKey.id);
  assert.ok(reloaded, "重启后用户级 Key 仍应被加载");
  assert.equal(store.getKeyLocation(userKey.id)?.scope, "user");
}

function testRevocationSurvivesReload(): void {
  const userKey = keyStore.issueApiKey({
    userId: USER_ID,
    scope: "user",
    name: "revoked",
    rawKey: "sk-revoked",
  });

  assert.equal(keyStore.revokeApiKey(userKey.id), true);

  store.loadAllEntities();
  const reloaded = store.getApiKey(userKey.id);
  assert.ok(reloaded?.revokedAt, "吊销状态必须落盘并在重启后保持");
  assert.equal(
    keyStore.validateApiKey("sk-revoked"),
    null,
    "已吊销的 Key 不应再通过认证",
  );
}

// ---------------------------------------------------------------------------
// 2.6 删除用户级 Key 的内存索引
// ---------------------------------------------------------------------------

function testDeleteUserRemovesUserScopedKeyFromIndex(): void {
  const userKey = keyStore.issueApiKey({
    userId: USER_ID,
    scope: "user",
    name: "doomed",
    rawKey: "sk-doomed",
  });
  assert.ok(keyStore.validateApiKey("sk-doomed"), "前置条件：Key 可认证");

  store.deleteUser(USER_ID);

  assert.equal(store.getApiKey(userKey.id), undefined, "用户级 Key 应从内存索引移除");
  assert.equal(
    keyStore.validateApiKey("sk-doomed"),
    null,
    "删除用户后该 Key 不应再能通过认证",
  );

  store.loadAllEntities();
  assert.equal(
    store.getApiKey(userKey.id),
    undefined,
    "重新加载后也不应再出现",
  );
}

// ---------------------------------------------------------------------------
// 2.7 deleteKey 按作用域分支
// ---------------------------------------------------------------------------

function testDeleteUserScopedKeyRemovesFile(): void {
  setupUser();
  setupAccount("acc-A", true);

  const userKey = keyStore.issueApiKey({
    userId: USER_ID,
    scope: "user",
    name: "to-delete",
    rawKey: "sk-to-delete",
  });
  const keyFile = path.join(TMP_DIR, "users", USER_ID, "keys", userKey.id, "key.json");
  assert.ok(fs.existsSync(keyFile));

  store.deleteKey(USER_ID, "", userKey.id, "user");

  assert.ok(!fs.existsSync(keyFile), "删除后磁盘文件应不存在");
  assert.equal(store.getApiKey(userKey.id), undefined, "内存索引应同步清除");

  store.loadAllEntities();
  assert.equal(
    store.getApiKey(userKey.id),
    undefined,
    "重启后该 Key 不应复现",
  );
}

// ---------------------------------------------------------------------------
// 2.8 getUserApiKey 只返回账号级 Key
// ---------------------------------------------------------------------------

function testGetUserApiKeySkipsUserScopedKeys(): void {
  setupUser();
  setupAccount("acc-A", true);

  const userKey = keyStore.issueApiKey({
    userId: USER_ID,
    scope: "user",
    name: "aggregate",
    rawKey: "sk-aggregate",
  });
  assert.equal(keyStore.getUserApiKey(USER_ID), null, "只有用户级 Key 时不应返回它");

  const accountKey = keyStore.issueApiKey({
    userId: USER_ID,
    providerAccountId: "acc-A",
    name: "account-scoped",
    rawKey: "sk-account-scoped",
  });
  assert.ok(
    keyStore.getUserApiKey(USER_ID),
    "存在账号级 Key 时应返回账号级 Key 的哈希",
  );
  assert.notEqual(keyStore.getUserApiKey(USER_ID), userKey.keyHash);
  assert.ok(accountKey.id);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

try {
  testLegacyKeySemanticsUnchanged();
  testOneKeyTwoAccountsHaveOwnSessions();
  testAuthContextBranches();
  testKeyLocationCarriesScope();
  testUserScopedKeyPathAndReload();
  testRevocationSurvivesReload();
  testDeleteUserRemovesUserScopedKeyFromIndex();
  testDeleteUserScopedKeyRemovesFile();
  testGetUserApiKeySkipsUserScopedKeys();
  console.log("All hierarchical store tests passed.");
} finally {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}
