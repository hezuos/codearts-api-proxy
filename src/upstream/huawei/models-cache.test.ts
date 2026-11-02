/**
 * 模型列表账号级缓存测试（add-account-routing 任务 6.2）。
 *
 * 覆盖：模型列表按选中账号的凭据获取；缓存按账号隔离——两个账号可见模型
 * 不同时，后取的账号 SHALL 拿到自己的模型列表。
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "models-cache-test-"));
process.env.DATA_DIR = TMP_DIR;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const encryption = require("../../auth/crypto/encryption") as typeof import("../../auth/crypto/encryption");
import { getModelList, __testHooks } from "./models";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";

function makeSession(accountId: string): StoredHuaweiSession {
  return {
    keyId: "key-" + accountId,
    providerAccountId: accountId,
    accessKey: "AK-" + accountId,
    secretKeyCiphertext: encryption.encryptString("SK-" + accountId),
    securityToken: "token",
    businessToken: "bt-" + accountId,
  };
}

let fetchCount = 0;

function mockUpstream(): void {
  fetchCount = 0;
  __testHooks.setHttpsGet(async (url, headers) => {
    const token = String(headers["x-auth-token"] ?? "");
    fetchCount++;
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
      return {
        status: 200,
        body: JSON.stringify({
          gpts: { models: [{ model_alias: "model-of-" + token }] },
        }),
      };
    }
    return { status: 404, body: "" };
  });
}

async function testCacheIsolatedPerAccount(): Promise<void> {
  mockUpstream();
  try {
    const listA = await getModelList("acc-A", makeSession("acc-A"), "t1");
    const idsA = listA.map((m) => m.id);
    assert.ok(
      idsA.includes("model-of-bt-acc-A"),
      "账号 A SHALL 拿到自己的模型列表",
    );

    const listB = await getModelList("acc-B", makeSession("acc-B"), "t2");
    const idsB = listB.map((m) => m.id);
    assert.ok(
      idsB.includes("model-of-bt-acc-B"),
      "账号 B SHALL 拿到自己的模型列表（不被账号 A 的缓存污染）",
    );
    assert.ok(
      !idsB.includes("model-of-bt-acc-A"),
      "账号 B SHALL NOT 拿到账号 A 的模型",
    );

    const fetchCountAfterTwo = fetchCount;

    // 再次请求账号 A → 命中账号 A 自己的缓存，不再打上游
    const listA2 = await getModelList("acc-A", makeSession("acc-A"), "t3");
    assert.deepEqual(
      listA2.map((m) => m.id),
      idsA,
      "缓存命中 SHALL 返回同一份模型列表",
    );
    assert.equal(
      fetchCount,
      fetchCountAfterTwo,
      "缓存命中 SHALL NOT 再次请求上游",
    );
  } finally {
    __testHooks.setHttpsGet(null);
  }
}

async function testForceRefreshBypassesCache(): Promise<void> {
  mockUpstream();
  try {
    await getModelList("acc-C", makeSession("acc-C"), "t4");
    const before = fetchCount;
    await getModelList("acc-C", makeSession("acc-C"), "t5", true);
    assert.ok(
      fetchCount > before,
      "强制刷新 SHALL 绕过缓存重新请求上游",
    );
  } finally {
    __testHooks.setHttpsGet(null);
  }
}

async function main(): Promise<void> {
  await testCacheIsolatedPerAccount();
  await testForceRefreshBypassesCache();
  console.log("All model cache tests passed.");
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

void main();
