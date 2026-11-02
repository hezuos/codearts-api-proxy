/**
 * 路由集成冒烟测试（add-account-routing 组 8）。
 *
 * 覆盖 8.2 / 8.3 / 8.4 描述的冒烟场景：用真实的选择器、候选池、并发闸门与
 * 分层存储跑完整路由链路，上游调用以桩函数替代。
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import type { Request, Response } from "express";
import type { OpenAIChatCompletionRequest } from "../types/openai";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "routing-smoke-"));
process.env.DATA_DIR = TMP_DIR;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require("../store/hierarchical-store") as typeof import("../store/hierarchical-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const keyStore = require("../store/api-key-store") as typeof import("../store/api-key-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const encryption = require("../auth/crypto/encryption") as typeof import("../auth/crypto/encryption");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const selector = require("./account-selector") as typeof import("./account-selector");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gateModule = require("../upstream/huawei/upstream-gate") as typeof import("../upstream/huawei/upstream-gate");
import { runMigrationLoop } from "./migration-loop";
import { resolveConversationIdentity } from "../upstream/huawei/conversation-id";
import { buildV2RequestBody } from "../upstream/huawei/chat-request";
import { regenerateApiKey } from "../routes/web-ui";
import type { AuthContext } from "../store/api-key-store";

const NOW = "2026-01-01T00:00:00.000Z";
const USER_MULTI = "user-smoke-multi";
const USER_POOL = "user-smoke-pool";

for (const userId of [USER_MULTI, USER_POOL]) {
  store.setUser({
    id: userId,
    displayName: userId,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function addAccount(
  userId: string,
  accountId: string,
  rawKey: string,
): string {
  store.setProviderAccount({
    id: accountId,
    userId,
    provider: "huawei-codearts",
    displayName: accountId,
    isDefault: false,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const key = keyStore.issueApiKey({
    userId,
    providerAccountId: accountId,
    name: "key-" + accountId,
    rawKey,
  });
  store.setSession(key.id, {
    keyId: key.id,
    providerAccountId: accountId,
    accessKey: "AK-" + accountId,
    secretKeyCiphertext: encryption.encryptString("SK-" + accountId),
    securityToken: "token",
    businessToken: "bt-" + accountId,
  });
  return key.id;
}

/** 通过稳定对话键解析对话标识——顺带验证身份来源链。 */
function conversationIdFor(stableKey: string): string {
  const identity = resolveConversationIdentity({
    model: "glm-5.3",
    messages: [{ role: "user", content: "你好" }],
    codearts: { conversation_id: stableKey },
  } as unknown as OpenAIChatCompletionRequest);
  assert.ok(identity.conversationId, "SHALL 解析出稳定对话标识");
  assert.equal(identity.source, "stable-key");
  return identity.conversationId!;
}

interface AttemptRecord {
  accountId: string;
  keyId: string;
}

/** 跑一次完整路由，返回实际命中的账号。 */
async function routeOnce(
  auth: AuthContext,
  conversationId: string | undefined,
): Promise<AttemptRecord> {
  const records: AttemptRecord[] = [];
  let failure: unknown = null;
  await runMigrationLoop({
    auth,
    conversationId,
    signal: new AbortController().signal,
    attempt: async (target) => {
      records.push({ accountId: target.accountId, keyId: target.keyId });
    },
    responseStarted: () => false,
    onFinalError: (error) => {
      failure = error;
    },
  });
  assert.equal(failure, null, "路由 SHALL NOT 失败：" + String(failure));
  assert.equal(records.length, 1, "SHALL 只尝试一个账号");
  return records[0];
}

// ---------------------------------------------------------------------------
// 8.2 单 Key 绑定两账号：连续对话命中同一账号；占满后自动迁移且不报错
// ---------------------------------------------------------------------------

async function testSmokeMultiAccountKey(): Promise<void> {
  selector.__testHooks.reset();
  gateModule.__testHooks.reset();
  gateModule.__testHooks.setLimit(1);

  const multiKey = keyStore.issueApiKey({
    userId: USER_MULTI,
    providerAccountId: "m-acc-1",
    providerAccountIds: ["m-acc-1", "m-acc-2"],
    name: "multi-account",
    rawKey: "sk-smoke-multi",
  });
  for (const accountId of ["m-acc-1", "m-acc-2"]) {
    store.setProviderAccount({
      id: accountId,
      userId: USER_MULTI,
      provider: "huawei-codearts",
      displayName: accountId,
      isDefault: accountId === "m-acc-1",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    store.setSession(multiKey.id, {
      keyId: multiKey.id,
      providerAccountId: accountId,
      accessKey: "AK-" + accountId,
      secretKeyCiphertext: encryption.encryptString("SK-" + accountId),
      securityToken: "token",
      businessToken: "bt-" + accountId,
    });
  }

  const auth = keyStore.validateApiKey("sk-smoke-multi");
  assert.ok(auth);
  assert.equal(auth!.kind, "account");

  const conversationId = conversationIdFor("smoke-conv-1");

  const first = await routeOnce(auth!, conversationId);
  assert.equal(first.accountId, "m-acc-1", "首轮 SHALL 命中首选账号");

  const second = await routeOnce(auth!, conversationId);
  assert.equal(
    second.accountId,
    "m-acc-1",
    "连续对话 SHALL 始终命中同一账号",
  );

  // 人为占满该账号的并发槽位
  const release = await gateModule.acquireUpstreamSlot("m-acc-1");
  try {
    const third = await routeOnce(auth!, conversationId);
    assert.equal(
      third.accountId,
      "m-acc-2",
      "占满后 SHALL 自动迁移到另一账号",
    );
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// 8.3 用户级 Key：对话连续时三段新对话落到三个账号；改按请求后逐请求轮询
// ---------------------------------------------------------------------------

async function testSmokeUserScopedKey(): Promise<void> {
  selector.__testHooks.reset();
  gateModule.__testHooks.reset();
  gateModule.__testHooks.setLimit(3);

  for (const accountId of ["p-acc-1", "p-acc-2", "p-acc-3"]) {
    addAccount(USER_POOL, accountId, "sk-" + accountId);
  }

  const userKey = keyStore.issueApiKey({
    userId: USER_POOL,
    scope: "user",
    balancingPolicy: "conversation",
    name: "user-conversation",
    rawKey: "sk-smoke-user-conv",
  });
  const auth = keyStore.validateApiKey("sk-smoke-user-conv");
  assert.ok(auth);
  assert.equal(auth!.kind, "aggregate");

  // 三段新对话分别落到三个账号
  const firstRound: string[] = [];
  const conversationIds = [
    conversationIdFor("smoke-conv-a"),
    conversationIdFor("smoke-conv-b"),
    conversationIdFor("smoke-conv-c"),
  ];
  for (const conversationId of conversationIds) {
    const record = await routeOnce(auth!, conversationId);
    firstRound.push(record.accountId);
  }
  assert.equal(
    new Set(firstRound).size,
    3,
    "三段新对话 SHALL 分别落到三个不同账号",
  );

  // 每段对话后续轮次命中原账号
  for (let i = 0; i < conversationIds.length; i++) {
    const record = await routeOnce(auth!, conversationIds[i]);
    assert.equal(
      record.accountId,
      firstRound[i],
      "同一对话的后续轮次 SHALL 命中原账号",
    );
  }

  // 切换为"按请求"后连续请求落到不同账号
  userKey.balancingPolicy = "request";
  store.persistApiKey(userKey);
  const requestAuth = keyStore.validateApiKey("sk-smoke-user-conv");
  assert.ok(requestAuth);

  const requestRound: string[] = [];
  for (let i = 0; i < 3; i++) {
    const record = await routeOnce(requestAuth!, conversationIds[0]);
    requestRound.push(record.accountId);
  }
  assert.equal(
    new Set(requestRound).size,
    3,
    "按请求粒度下连续请求 SHALL 落到不同账号",
  );

  // 对话内容完整：两轮消息原样进入上游请求体
  const session = store.getSession(
    firstRound.length > 0
      ? keyStore.listApiKeysByUser(USER_POOL)[0].id
      : "",
    firstRound[0],
  );
  assert.ok(session, "SHALL 取到被选中账号的会话");
  const request = {
    model: "glm-5.3",
    messages: [
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
    ],
    codearts: { conversation_id: "smoke-conv-a" },
  } as unknown as OpenAIChatCompletionRequest;
  const built = buildV2RequestBody(request, session!);
  const messages = built.body.messages as Array<{ content: string }>;
  assert.equal(messages.length, 3, "SHALL 完整转发全部消息");
  assert.equal(messages[0].content, "第一问");
  assert.equal(messages[2].content, "第二问");
}

// ---------------------------------------------------------------------------
// 8.4 创建用户级 Key 后执行"重新生成账号密钥"，用户级 Key 仍可用
// ---------------------------------------------------------------------------

async function testSmokeRegenerateKeepsUserKey(): Promise<void> {
  selector.__testHooks.reset();
  gateModule.__testHooks.reset();
  gateModule.__testHooks.setLimit(3);

  const userId = "user-smoke-regen";
  store.setUser({
    id: userId,
    displayName: userId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const accountKeyId = addAccount(userId, "r-acc-1", "sk-regen-account");
  const userKey = keyStore.issueApiKey({
    userId,
    scope: "user",
    balancingPolicy: "conversation",
    name: "user-key",
    rawKey: "sk-regen-user",
  });

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

  regenerateApiKey(
    {
      params: {},
      body: {},
      uiAuth: { userId, apiKeyId: accountKeyId },
    } as unknown as Request,
    res,
  );
  assert.equal(state.statusCode, 200, "重新生成 SHALL 成功");

  const userKeyAfter = store.getApiKey(userKey.id);
  assert.ok(userKeyAfter, "用户级 Key SHALL 仍然存在");
  assert.equal(
    userKeyAfter!.revokedAt,
    undefined,
    "用户级 Key SHALL NOT 被连带吊销",
  );
  assert.equal(
    userKeyAfter!.balancingPolicy,
    "conversation",
    "用户级 Key 的分配粒度 SHALL 不变",
  );

  // 仍可鉴权并路由
  const auth = keyStore.validateApiKey("sk-regen-user");
  assert.ok(auth, "用户级 Key SHALL 仍可用");
  assert.equal(auth!.kind, "aggregate");
  const record = await routeOnce(auth!, conversationIdFor("smoke-regen"));
  assert.equal(record.accountId, "r-acc-1");
}

async function main(): Promise<void> {
  await testSmokeMultiAccountKey();
  await testSmokeUserScopedKey();
  await testSmokeRegenerateKeepsUserKey();
  console.log("All routing smoke tests passed.");
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

void main();
