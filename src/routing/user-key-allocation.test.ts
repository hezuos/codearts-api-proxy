/**
 * 用户级 Key 分配策略测试（add-account-routing 组 5）。
 *
 * 覆盖：轮询游标、对话粒度、请求粒度、对话绑定表、候选集求值、会话借用、
 * 模型列表获取与空候选集错误。
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import type { Request, Response } from "express";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "alloc-test-"));
process.env.DATA_DIR = TMP_DIR;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require("../store/hierarchical-store") as typeof import("../store/hierarchical-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const keyStore = require("../store/api-key-store") as typeof import("../store/api-key-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const selector = require("./account-selector") as typeof import("./account-selector");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const candidatePool = require("./candidate-pool") as typeof import("./candidate-pool");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const models = require("../upstream/huawei/models") as typeof import("../upstream/huawei/models");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const encryption = require("../auth/crypto/encryption") as typeof import("../auth/crypto/encryption");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const configModule = require("../config") as typeof import("../config");
import { planRoute } from "./request-router";
import { listModels } from "../routes/openai";
import type { AuthContext } from "../store/api-key-store";

const NOW = "2026-01-01T00:00:00.000Z";
const USER_ID = "user-alloc";
const ACCOUNT_IDS = ["acc-1", "acc-2", "acc-3"];

store.setUser({
  id: USER_ID,
  displayName: "tester",
  createdAt: NOW,
  updatedAt: NOW,
});

for (const accountId of ACCOUNT_IDS) {
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
    secretKeyCiphertext: encryption.encryptString("SK-" + accountId),
    securityToken: "token",
    businessToken: "bt-" + accountId,
  });
}

keyStore.issueApiKey({
  userId: USER_ID,
  scope: "user",
  balancingPolicy: "conversation",
  name: "user-conversation",
  rawKey: "sk-user-conv",
});
keyStore.issueApiKey({
  userId: USER_ID,
  scope: "user",
  balancingPolicy: "request",
  name: "user-request",
  rawKey: "sk-user-req",
});

const convAuth = keyStore.validateApiKey("sk-user-conv");
const reqAuth = keyStore.validateApiKey("sk-user-req");
assert.equal(convAuth?.kind, "aggregate");
assert.equal(reqAuth?.kind, "aggregate");

function resetRoutingState(): void {
  selector.__testHooks.reset();
}

function makeModelsReq(auth: AuthContext): Request {
  return {
    auth,
    query: { refresh: "true" },
    header: () => undefined,
  } as unknown as Request;
}

function makeModelsRes(): {
  res: Response;
  statusCode: () => number;
  body: () => { data?: Array<{ id?: string }> };
} {
  const state = {
    statusCode: 0,
    body: undefined as { data?: Array<{ id?: string }> } | undefined,
  };
  const res = {
    headersSent: false,
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: { data?: Array<{ id?: string }> }) {
      if (state.statusCode === 0) state.statusCode = 200;
      state.body = payload;
      return res;
    },
    setHeader() {
      return res;
    },
  } as unknown as Response;
  return {
    res,
    statusCode: () => state.statusCode,
    body: () => state.body ?? {},
  };
}

// ---------------------------------------------------------------------------
// 5.1 轮询游标：连续推进得到不同账号；重启后从初始位重新开始
// ---------------------------------------------------------------------------

function testRoundRobinCursorAdvances(): void {
  resetRoutingState();
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const plan = planRoute({ auth: reqAuth! });
    assert.ok(plan);
    seen.push(plan!.target.accountId);
  }
  assert.equal(new Set(seen).size, 3, "连续三次 SHALL 落到三个不同账号");

  // 模拟重启：内存状态归零
  resetRoutingState();
  const afterRestart = planRoute({ auth: reqAuth! });
  assert.equal(
    afterRestart?.target.accountId,
    ACCOUNT_IDS[0],
    "重启后 SHALL 从初始位重新开始",
  );
}

// ---------------------------------------------------------------------------
// 5.2 对话粒度：新对话推进游标，同对话后续命中绑定
// ---------------------------------------------------------------------------

function testConversationGranularity(): void {
  resetRoutingState();
  const seen: string[] = [];
  for (const conversationId of ["c1", "c2", "c3"]) {
    const plan = planRoute({ auth: convAuth!, conversationId });
    assert.ok(plan);
    seen.push(plan!.target.accountId);
  }
  assert.equal(new Set(seen).size, 3, "三个新对话 SHALL 落到三个不同账号");

  const again = planRoute({ auth: convAuth!, conversationId: "c1" });
  assert.equal(
    again?.target.accountId,
    seen[0],
    "同对话第二轮 SHALL 命中原账号",
  );
  assert.equal(again?.reason, "sticky-hit");
}

// ---------------------------------------------------------------------------
// 5.3 请求粒度：每请求推进游标，不保持绑定
// ---------------------------------------------------------------------------

function testRequestGranularity(): void {
  resetRoutingState();
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const plan = planRoute({ auth: reqAuth!, conversationId: "same-conv" });
    assert.ok(plan);
    seen.push(plan!.target.accountId);
  }
  assert.equal(new Set(seen).size, 3, "连续三个请求 SHALL 落到三个不同账号");
  assert.notEqual(seen[0], seen[1], "同对话两轮 SHALL NOT 被绑定到同一账号");
}

// ---------------------------------------------------------------------------
// 5.4 对话绑定表：按 (Key, 对话标识) 寻址、空闲超时、容量上限、解绑失效
// ---------------------------------------------------------------------------

function testBindingTableAddressing(): void {
  resetRoutingState();
  const planA = planRoute({ auth: convAuth!, conversationId: "addr-1" });
  const planB = planRoute({ auth: reqAuth!, conversationId: "addr-1" });
  assert.ok(planA);
  assert.ok(planB);
  assert.equal(
    planB?.reason,
    "round-robin",
    "不同 Key 的同对话标识 SHALL 互不干扰（绑定表按 Key 分区）",
  );
  assert.ok(planA);
}

function testBindingIdleTimeout(): void {
  resetRoutingState();
  const config = configModule.config;
  const original = config.routingStickyIdleMs;
  config.routingStickyIdleMs = 40;
  try {
    const first = planRoute({ auth: convAuth!, conversationId: "idle-1" });
    assert.ok(first);
    const until = Date.now() + 60;
    while (Date.now() < until) {
      // busy wait
    }
    const second = planRoute({ auth: convAuth!, conversationId: "idle-1" });
    assert.equal(
      second?.reason,
      "round-robin",
      "空闲超时后 SHALL 按新对话处理",
    );
  } finally {
    config.routingStickyIdleMs = original;
  }
}

function testBindingCapacityEviction(): void {
  resetRoutingState();
  const config = configModule.config;
  const original = config.routingStickyMaxEntries;
  config.routingStickyMaxEntries = 2;
  try {
    planRoute({ auth: convAuth!, conversationId: "cap-1" });
    planRoute({ auth: convAuth!, conversationId: "cap-2" });
    planRoute({ auth: convAuth!, conversationId: "cap-3" });
    assert.equal(
      selector.countStickyBindings(),
      2,
      "超出容量时 SHALL 淘汰旧条目",
    );
  } finally {
    config.routingStickyMaxEntries = original;
  }
}

function testBindingInvalidatedWhenAccountUnbound(): void {
  resetRoutingState();
  const first = planRoute({ auth: convAuth!, conversationId: "unbind-1" });
  assert.ok(first);
  const boundAccount = first!.target.accountId;

  // 吊销该账号的账号级 Key → 账号退出候选集 → 绑定自然失效
  const accountKey = keyStore
    .listApiKeysByUser(USER_ID)
    .find((k) => k.providerAccountId === boundAccount);
  assert.ok(accountKey);
  keyStore.revokeApiKey(accountKey!.id);

  const second = planRoute({ auth: convAuth!, conversationId: "unbind-1" });
  assert.ok(second);
  assert.notEqual(
    second!.target.accountId,
    boundAccount,
    "账号解绑后 SHALL NOT 再选中该账号",
  );
}

// ---------------------------------------------------------------------------
// 5.5 候选集三条件合取，每次请求重新求值
// ---------------------------------------------------------------------------

function testCandidateSetReevaluatedPerRequest(): void {
  resetRoutingState();
  const target = ACCOUNT_IDS[ACCOUNT_IDS.length - 1];
  const targetKey = keyStore
    .listApiKeysByUser(USER_ID)
    .find((k) => k.providerAccountId === target && !k.revokedAt);
  assert.ok(targetKey, "前置条件：目标账号的 Key 未被吊销");

  const inPool = () =>
    candidatePool
      .listUsableAccounts(USER_ID)
      .some((a) => a.accountId === target);

  assert.equal(inPool(), true, "前置条件：目标账号在候选集中");

  // 会话失效（缺 AK）→ 退出候选集
  store.setSession(targetKey!.id, {
    keyId: targetKey!.id,
    providerAccountId: target,
    accessKey: "",
    secretKeyCiphertext: "cipher",
  });
  assert.equal(inPool(), false, "会话失效后 SHALL 退出候选集");

  // 会话恢复 → 重新进入候选集
  store.setSession(targetKey!.id, {
    keyId: targetKey!.id,
    providerAccountId: target,
    accessKey: "AK-" + target,
    secretKeyCiphertext: "cipher",
    securityToken: "token",
    businessToken: "bt-" + target,
  });
  assert.equal(inPool(), true, "会话恢复后 SHALL 重新进入候选集");

  // 账号级 Key 被吊销 → 退出候选集
  keyStore.revokeApiKey(targetKey!.id);
  assert.equal(inPool(), false, "账号级 Key 被吊销后 SHALL 退出候选集");
}

// ---------------------------------------------------------------------------
// 5.6 会话借用：从被选中账号下可用 Key 借用
// ---------------------------------------------------------------------------

function testSessionBorrowedFromSelectedAccount(): void {
  resetRoutingState();
  const plan = planRoute({ auth: reqAuth! });
  assert.ok(plan);
  const selected = plan!.target;
  const borrowedKey = keyStore.getApiKey(selected.keyId);
  assert.ok(borrowedKey, "借用的 SHALL 是账号级 Key");
  assert.equal(
    borrowedKey?.scope ?? "account",
    "account",
    "借用对象 SHALL 是账号级 Key",
  );
  assert.equal(borrowedKey?.providerAccountId, selected.accountId);
  assert.equal(selected.session.providerAccountId, selected.accountId);
}

// ---------------------------------------------------------------------------
// 5.7 /v1/models：用户级 Key 用首个可用账号的凭据
// ---------------------------------------------------------------------------

async function testUserScopedModelsUseFirstUsableAccount(): Promise<void> {
  resetRoutingState();
  const firstUsable = candidatePool.listUsableAccounts(USER_ID)[0];
  assert.ok(firstUsable, "前置条件：存在可用账号");
  const expectedToken = "bt-" + firstUsable!.accountId;
  const requestedTokens: string[] = [];
  models.__testHooks.setHttpsGet(async (url, headers) => {
    const token = String(headers["x-auth-token"] ?? "");
    requestedTokens.push(token);
    if (url.includes("/useragents")) {
      return {
        status: 200,
        body: JSON.stringify({
          total: 1,
          agents: [
            {
              agent_id: "agent-" + token,
              agent_name: "primary",
              is_primary_agent: true,
            },
          ],
        }),
      };
    }
    if (url.includes("/detail")) {
      // 每个账号可见的模型不同——返回结果可据此判定用的是哪个账号
      return {
        status: 200,
        body: JSON.stringify({
          gpts: { models: [{ model_alias: "model-of-" + token }] },
        }),
      };
    }
    return { status: 404, body: "" };
  });

  try {
    const { res, statusCode, body } = makeModelsRes();
    await listModels(makeModelsReq(reqAuth!), res);
    assert.equal(statusCode(), 200, "用户级 Key SHALL 能获取模型列表");
    const ids = (body().data ?? []).map((m) => m.id);
    assert.ok(ids.length > 0, "模型列表 SHALL 非空");
    assert.ok(
      requestedTokens.length > 0 && requestedTokens[0] === expectedToken,
      "SHALL 使用候选集中首个可用账号的凭据",
    );
    assert.ok(
      ids.includes("model-of-" + expectedToken),
      "返回结果 SHALL 来自被借用账号的可见模型",
    );
  } finally {
    models.__testHooks.setHttpsGet(null);
  }
}

// ---------------------------------------------------------------------------
// 5.8 候选集为空 → 明确的鉴权错误
// ---------------------------------------------------------------------------

async function testEmptyCandidateSetReturnsAuthError(): Promise<void> {
  resetRoutingState();
  // 吊销该用户下剩余的账号级 Key
  for (const key of keyStore.listApiKeysByUser(USER_ID)) {
    if (!key.revokedAt && (key.scope ?? "account") === "account") {
      keyStore.revokeApiKey(key.id);
    }
  }

  const { res, statusCode } = makeModelsRes();
  await listModels(makeModelsReq(reqAuth!), res);
  assert.equal(
    statusCode(),
    401,
    "候选集为空时 SHALL 返回鉴权错误而非回落到任意账号",
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  testRoundRobinCursorAdvances();
  testConversationGranularity();
  testRequestGranularity();
  testBindingTableAddressing();
  testBindingIdleTimeout();
  testBindingCapacityEviction();
  testBindingInvalidatedWhenAccountUnbound();
  testCandidateSetReevaluatedPerRequest();
  testSessionBorrowedFromSelectedAccount();
  await testUserScopedModelsUseFirstUsableAccount();
  await testEmptyCandidateSetReturnsAuthError();
  console.log("All user key allocation tests passed.");
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

void main();
