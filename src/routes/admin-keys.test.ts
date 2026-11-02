/**
 * 管理界面与密钥生命周期测试（add-account-routing 组 7）。
 *
 * 覆盖：多账号绑定与编辑、账号健康与冷却、用户级 Key 分区、原始密钥一次性返回、
 * 粒度切换、重新生成不吊销用户级 Key、刷新返回 4xx、删除同时清除磁盘与内存。
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import type { Request, Response } from "express";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "admin-keys-test-"));
process.env.DATA_DIR = TMP_DIR;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require("../store/hierarchical-store") as typeof import("../store/hierarchical-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const keyStore = require("../store/api-key-store") as typeof import("../store/api-key-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const encryption = require("../auth/crypto/encryption") as typeof import("../auth/crypto/encryption");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const selector = require("../routing/account-selector") as typeof import("../routing/account-selector");
import {
  getAllUsers,
  getAllAccounts,
  listUserScopedKeys,
  createUserScopedKey,
  createAccountApiKey,
  updateKeyAccounts,
  updateKeyPolicy,
  refreshApiKey,
  deleteApiKey,
} from "./admin";
import { regenerateApiKey } from "./web-ui";

const NOW = "2026-01-01T00:00:00.000Z";
const USER_ID = "user-admin";
const ACCOUNT_IDS = ["acc-1", "acc-2", "acc-3"];

store.setUser({
  id: USER_ID,
  displayName: "admin tester",
  createdAt: NOW,
  updatedAt: NOW,
});

/** 每个账号各持有一个账号级 Key 与一份可用会话。 */
const accountKeys: Record<string, string> = {};
for (const accountId of ACCOUNT_IDS) {
  store.setProviderAccount({
    id: accountId,
    userId: USER_ID,
    provider: "huawei-codearts",
    displayName: "account " + accountId,
    isDefault: accountId === "acc-1",
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
  accountKeys[accountId] = key.id;
  store.setSession(key.id, {
    keyId: key.id,
    providerAccountId: accountId,
    accessKey: "AK-" + accountId,
    secretKeyCiphertext: encryption.encryptString("SK-" + accountId),
    securityToken: "token",
    businessToken: "bt-" + accountId,
  });
}

interface MockRes {
  res: Response;
  statusCode: () => number;
  body: () => Record<string, unknown>;
}

function makeRes(): MockRes {
  const state = { statusCode: 0, body: {} as Record<string, unknown> };
  const res = {
    headersSent: false,
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: Record<string, unknown>) {
      if (state.statusCode === 0) state.statusCode = 200;
      state.body = payload;
      return res;
    },
    cookie() {
      return res;
    },
  } as unknown as Response;
  return { res, statusCode: () => state.statusCode, body: () => state.body };
}

function makeReq(
  params: Record<string, string>,
  body?: Record<string, unknown>,
  uiAuth?: { userId: string; apiKeyId: string },
): Request {
  return {
    params,
    body: body ?? {},
    uiAuth,
  } as unknown as Request;
}

// ---------------------------------------------------------------------------
// 7.1 Key 创建/编辑支持多选绑定账号，首选账号可指定
// ---------------------------------------------------------------------------

function testCreateKeyWithMultipleAccounts(): string {
  const m = makeRes();
  createAccountApiKey(
    makeReq(
      {},
      {
        userId: USER_ID,
        name: "multi",
        providerAccountId: "acc-1",
        providerAccountIds: ["acc-1", "acc-2"],
      },
    ),
    m.res,
  );
  assert.equal(m.statusCode(), 200);
  const rawKey = m.body().apiKey as string;
  assert.ok(rawKey, "创建响应 SHALL 携带原始密钥");

  const key = store.findApiKeyByValue(rawKey);
  assert.ok(key, "创建的 Key SHALL 可被检索");
  assert.equal(key!.providerAccountId, "acc-1", "首选账号 SHALL 被记录");
  assert.deepEqual(
    key!.providerAccountIds,
    ["acc-1", "acc-2"],
    "绑定列表 SHALL 包含全部选中账号",
  );
  assert.ok(
    store.getSession(key!.id, "acc-1"),
    "绑定账号 SHALL 各自持有会话",
  );
  assert.ok(
    store.getSession(key!.id, "acc-2"),
    "绑定账号 SHALL 各自持有会话",
  );
  return key!.id;
}

// ---------------------------------------------------------------------------
// 7.2 展示各账号健康状态与冷却剩余时间
// ---------------------------------------------------------------------------

function testAccountHealthExposed(): void {
  selector.markAccountCoolingDown("acc-2", "concurrency");
  const m = makeRes();
  getAllAccounts(makeReq({}), m.res);
  assert.equal(m.statusCode(), 200);

  const accounts = m.body().accounts as Array<{
    id: string;
    health: {
      cooldownMs: number;
      cooldownReason: string | null;
      hasFreeSlot: boolean;
    };
  }>;
  const cooling = accounts.find((a) => a.id === "acc-2");
  assert.ok(cooling, "账号 SHALL 出现在列表中");
  assert.ok(
    cooling!.health.cooldownMs > 0,
    "冷却中的账号 SHALL 上报冷却剩余时间",
  );
  assert.equal(cooling!.health.cooldownReason, "concurrency");

  const healthy = accounts.find((a) => a.id === "acc-1");
  assert.ok(healthy);
  assert.equal(healthy!.health.cooldownMs, 0);
  assert.equal(
    typeof healthy!.health.hasFreeSlot,
    "boolean",
    "SHALL 上报槽位可用性",
  );
  selector.clearAccountCooldown("acc-2");
}

// ---------------------------------------------------------------------------
// 7.3 用户级 Key 独立分区，展示作用域与分配粒度
// ---------------------------------------------------------------------------

function testUserKeysPartition(): void {
  const m = makeRes();
  createUserScopedKey(
    makeReq({ userId: USER_ID }, { name: "partition-key" }),
    m.res,
  );
  assert.equal(m.statusCode(), 200);

  const m2 = makeRes();
  getAllUsers(makeReq({}), m2.res);
  const users = m2.body().users as Array<{
    id: string;
    userKeys: Array<{ id: string; scope: string; balancingPolicy: string }>;
  }>;
  const user = users.find((u) => u.id === USER_ID);
  assert.ok(user, "用户 SHALL 出现在列表中");
  assert.ok(user!.userKeys.length >= 1, "用户级 Key SHALL 在独立分区");
  assert.equal(user!.userKeys[0].scope, "user", "SHALL 显式标注作用域");
  assert.ok(
    user!.userKeys[0].balancingPolicy,
    "SHALL 显式标注分配粒度",
  );
}

// ---------------------------------------------------------------------------
// 7.4 原始密钥由创建响应一次性返回，列表只返回哈希
// ---------------------------------------------------------------------------

function testRawKeyReturnedOnce(): { keyId: string; rawKey: string } {
  const m = makeRes();
  createUserScopedKey(
    makeReq({ userId: USER_ID }, { balancingPolicy: "request" }),
    m.res,
  );
  assert.equal(m.statusCode(), 200);
  const rawKey = m.body().apiKey as string;
  const keyId = m.body().id as string;
  assert.ok(rawKey.startsWith("sk-"), "创建响应 SHALL 携带原始密钥");
  assert.equal(
    m.body().balancingPolicy,
    "request",
    "用户 SHALL 能改选按请求粒度",
  );

  // 默认粒度为对话连续
  const mDefault = makeRes();
  createUserScopedKey(makeReq({ userId: USER_ID }, {}), mDefault.res);
  assert.equal(
    mDefault.body().balancingPolicy,
    "conversation",
    "缺省 SHALL 为对话连续",
  );

  // 列表只暴露哈希
  const mList = makeRes();
  listUserScopedKeys(makeReq({}), mList.res);
  const keys = mList.body().userKeys as Array<{
    id: string;
    keyHash: string;
  }>;
  const listed = keys.find((k) => k.id === keyId);
  assert.ok(listed, "用户级 Key SHALL 出现在列表中");
  assert.notEqual(listed!.keyHash, rawKey, "列表 SHALL NOT 暴露原始密钥");
  assert.equal(
    listed!.keyHash.length,
    64,
    "列表 SHALL 只暴露 SHA-256 哈希",
  );
  return { keyId, rawKey };
}

// ---------------------------------------------------------------------------
// 7.5 用户级 Key 支持粒度切换
// ---------------------------------------------------------------------------

function testSwitchPolicy(keyId: string): void {
  const m = makeRes();
  updateKeyPolicy(
    makeReq({ id: keyId }, { balancingPolicy: "request" }),
    m.res,
  );
  assert.equal(m.statusCode(), 200);
  assert.equal(
    store.getApiKey(keyId)!.balancingPolicy,
    "request",
    "粒度切换 SHALL 落库",
  );

  // 账号级 Key 没有分配粒度
  const m2 = makeRes();
  updateKeyPolicy(
    makeReq({ id: accountKeys["acc-1"] }, { balancingPolicy: "request" }),
    m2.res,
  );
  assert.equal(m2.statusCode(), 400, "账号级 Key SHALL 拒绝粒度切换");
}

// ---------------------------------------------------------------------------
// 7.7 Admin 对用户级 Key 的刷新请求返回明确的 4xx
// ---------------------------------------------------------------------------

async function testRefreshUserScopedKeyReturns4xx(keyId: string): Promise<void> {
  const m = makeRes();
  await refreshApiKey(makeReq({ id: keyId }), m.res);
  assert.ok(
    m.statusCode() >= 400 && m.statusCode() < 500,
    "刷新用户级 Key SHALL 返回 4xx，实际 " + m.statusCode(),
  );
  assert.equal(m.statusCode(), 400);
  assert.ok(
    String(m.body().error).length > 0,
    "SHALL 带有说明信息",
  );
  assert.ok(String(m.body().detail).length > 0, "SHALL 带有中文说明");
}

// ---------------------------------------------------------------------------
// 7.8 删除用户级 Key 后磁盘文件与内存索引同时清除
// ---------------------------------------------------------------------------

function testDeleteUserScopedKey(
  keyId: string,
  rawKey: string,
): void {
  const keyFile = path.join(TMP_DIR, "users", USER_ID, "keys", keyId, "key.json");
  assert.ok(fs.existsSync(keyFile), "创建后 SHALL 存在磁盘文件");

  const m = makeRes();
  deleteApiKey(makeReq({ id: keyId }), m.res);
  assert.equal(m.statusCode(), 200);
  assert.equal(
    fs.existsSync(keyFile),
    false,
    "删除后磁盘文件 SHALL 被清除",
  );
  assert.equal(store.getApiKey(keyId), undefined, "内存索引 SHALL 被清除");
  assert.equal(
    store.findApiKeyByValue(rawKey),
    undefined,
    "哈希索引 SHALL 被清除",
  );

  store.loadAllEntities();
  assert.equal(
    store.getApiKey(keyId),
    undefined,
    "重载后用户级 Key SHALL NOT 复活",
  );
}

// ---------------------------------------------------------------------------
// 7.6 "重新生成账号密钥"只作用于账号级 Key
// ---------------------------------------------------------------------------

function testRegenerateKeepsUserScopedKeys(): void {
  const userId = "user-regen";
  store.setUser({
    id: userId,
    displayName: "regen tester",
    createdAt: NOW,
    updatedAt: NOW,
  });
  store.setProviderAccount({
    id: "acc-regen",
    userId,
    provider: "huawei-codearts",
    displayName: "regen account",
    isDefault: true,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const accountKey = keyStore.issueApiKey({
    userId,
    providerAccountId: "acc-regen",
    name: "account-key",
    rawKey: "sk-regen-account",
  });
  store.setSession(accountKey.id, {
    keyId: accountKey.id,
    providerAccountId: "acc-regen",
    accessKey: "AK-regen",
    secretKeyCiphertext: encryption.encryptString("SK-regen"),
    securityToken: "token",
    businessToken: "bt-regen",
  });
  const userKey = keyStore.issueApiKey({
    userId,
    scope: "user",
    balancingPolicy: "conversation",
    name: "user-key",
    rawKey: "sk-regen-user",
  });

  const m = makeRes();
  regenerateApiKey(
    makeReq({}, {}, { userId, apiKeyId: accountKey.id }),
    m.res,
  );
  assert.equal(m.statusCode(), 200);

  const after = keyStore.listApiKeysByUser(userId);
  const userKeyAfter = after.find((k) => k.id === userKey.id);
  assert.ok(userKeyAfter, "用户级 Key SHALL 仍然存在");
  assert.equal(
    userKeyAfter!.revokedAt,
    undefined,
    "用户级 Key SHALL NOT 被重新生成连带吊销",
  );

  const accountKeyAfter = after.find((k) => k.id === accountKey.id);
  assert.ok(accountKeyAfter!.revokedAt, "账号级 Key SHALL 被吊销");
}

// ---------------------------------------------------------------------------
// 页面渲染断言：用户级 Key 分区、健康列、粒度二选一与缓存代价提示
// ---------------------------------------------------------------------------

/** HTML 扫描时忽略的自闭合/空元素。 */
const VOID_TAGS = new Set([
  "br",
  "hr",
  "img",
  "input",
  "meta",
  "link",
  "source",
  "area",
  "base",
  "col",
  "embed",
  "param",
  "track",
  "wbr",
]);

/**
 * 判断某元素是否嵌套在另一个元素内部。
 *
 * 弹窗若被包在另一个默认隐藏的弹窗里，自身加 `.active` 也不会显示——
 * 这类结构错误在页面上只表现为"点了没反应"，因此用结构断言兜住。
 */
function isNestedInside(
  html: string,
  innerId: string,
  outerId: string,
): boolean {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(cleaned)) !== null) {
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const attrs = match[3] ?? "";
    if (closing) {
      stack.pop();
      continue;
    }
    if (VOID_TAGS.has(tag) || /\/\s*$/.test(attrs)) continue;
    const idMatch = /id="([^"]+)"/.exec(attrs);
    stack.push(idMatch ? idMatch[1] : tag);
    if (idMatch && idMatch[1] === innerId) {
      return stack.slice(0, -1).includes(outerId);
    }
  }
  return false;
}

function testAdminPageRendering(): void {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "..", "public", "admin.html"),
    "utf8",
  );

  // 用户级 Key 独立分区
  assert.ok(
    html.includes('id="user-keys-table"'),
    "页面 SHALL 有用户级 Key 分区",
  );
  assert.ok(
    html.includes("用户级 Key（跨账号分配）"),
    "页面 SHALL 标注用户级 Key 分区",
  );

  // 账号健康列
  assert.ok(html.includes("<th>Health</th>"), "账号表 SHALL 有健康列");
  assert.ok(
    html.includes("buildHealthBadge"),
    "页面 SHALL 渲染账号健康与冷却剩余时间",
  );

  // 作用域与分配粒度展示
  assert.ok(html.includes("policyLabel"), "页面 SHALL 展示分配粒度");
  assert.ok(html.includes("用户级"), "页面 SHALL 显式标注作用域");

  // 粒度二选一，默认预选"对话连续"
  assert.ok(
    html.includes('name="user-key-policy" value="conversation" checked'),
    "分配粒度 SHALL 预选对话连续",
  );
  assert.ok(
    html.includes('name="user-key-policy" value="request"'),
    "分配粒度 SHALL 可改选按请求",
  );

  // 选中"按请求"时提示缓存代价
  assert.ok(
    html.includes("会牺牲上游缓存局部性"),
    "选中按请求时 SHALL 说明缓存代价",
  );
  assert.ok(
    html.includes("updatePolicyHint"),
    "页面 SHALL 在切换粒度时更新提示",
  );

  // 列表、删除与粒度切换入口
  assert.ok(html.includes("switchKeyPolicy"), "页面 SHALL 支持粒度切换");
  assert.ok(html.includes("deleteUserKey"), "页面 SHALL 支持删除用户级 Key");
  assert.ok(
    html.includes("openEditKeyAccountsModal"),
    "页面 SHALL 支持编辑 Key 的绑定账号",
  );

  // 原始密钥一次性返回
  assert.ok(
    html.includes("原始密钥仅显示这一次"),
    "页面 SHALL 提示原始密钥只显示一次",
  );

  // 弹窗不得嵌套在其它弹窗内——嵌套后永远不可见（点击"没反应"）
  for (const modalId of [
    "user-key-modal",
    "account-key-modal",
    "raw-key-modal",
  ]) {
    assert.equal(
      isNestedInside(html, modalId, "account-modal"),
      false,
      modalId + " SHALL NOT 嵌套在账号详情弹窗内",
    );
  }

  // 四个弹窗都应是 body 下的顶层元素
  for (const modalId of [
    "account-modal",
    "user-key-modal",
    "account-key-modal",
    "raw-key-modal",
  ]) {
    assert.equal(
      isNestedInside(html, modalId, "container"),
      false,
      modalId + " SHALL NOT 嵌套在 .container 内",
    );
  }
}

async function main(): Promise<void> {
  testAdminPageRendering();
  const multiKeyId = testCreateKeyWithMultipleAccounts();
  testAccountHealthExposed();
  testUserKeysPartition();
  const created = testRawKeyReturnedOnce();
  testSwitchPolicy(created.keyId);
  await testRefreshUserScopedKeyReturns4xx(created.keyId);
  testDeleteUserScopedKey(created.keyId, created.rawKey);
  testRegenerateKeepsUserScopedKeys();

  // 7.1 编辑绑定：换绑到 acc-3
  const m = makeRes();
  updateKeyAccounts(
    makeReq(
      { id: multiKeyId },
      { providerAccountId: "acc-3", providerAccountIds: ["acc-3"] },
    ),
    m.res,
  );
  assert.equal(m.statusCode(), 200);
  const updated = store.getApiKey(multiKeyId)!;
  assert.equal(updated.providerAccountId, "acc-3");
  assert.deepEqual(updated.providerAccountIds, ["acc-3"]);
  assert.equal(
    store.getSession(multiKeyId, "acc-1"),
    undefined,
    "解绑账号 SHALL 清掉自己的会话",
  );
  assert.ok(
    store.getSession(multiKeyId, "acc-3"),
    "新绑定账号 SHALL 持有会话",
  );

  console.log("All admin key management tests passed.");
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

void main();
