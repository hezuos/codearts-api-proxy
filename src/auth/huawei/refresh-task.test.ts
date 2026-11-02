/**
 * 刷新任务调度粒度测试（add-account-routing 任务 6.1）。
 *
 * 覆盖：按 (Key, Account) 独立调度、用户级 Key 不进入调度、调度状态可查。
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-task-test-"));
process.env.DATA_DIR = TMP_DIR;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require("../../store/hierarchical-store") as typeof import("../../store/hierarchical-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const keyStore = require("../../store/api-key-store") as typeof import("../../store/api-key-store");
import {
  startHuaweiRefreshTask,
  stopHuaweiRefreshTask,
  getRefreshSchedulerStatus,
} from "./refresh-task";

const NOW = "2026-01-01T00:00:00.000Z";
const USER_ID = "user-refresh";
const FUTURE = new Date(Date.now() + 3600_000).toISOString();

store.setUser({
  id: USER_ID,
  displayName: "tester",
  createdAt: NOW,
  updatedAt: NOW,
});

/** 一个账号级 Key 绑定两个账号，各自持有会话。 */
const multiAccountKey = keyStore.issueApiKey({
  userId: USER_ID,
  providerAccountId: "acc-A",
  providerAccountIds: ["acc-A", "acc-B"],
  name: "multi",
  rawKey: "sk-multi",
});

for (const accountId of ["acc-A", "acc-B"]) {
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
  store.setSession(multiAccountKey.id, {
    keyId: multiAccountKey.id,
    providerAccountId: accountId,
    accessKey: "AK-" + accountId,
    secretKeyCiphertext: "cipher",
    expiresAt: FUTURE,
  });
}

/** 用户级 Key 不持有自有会话。 */
keyStore.issueApiKey({
  userId: USER_ID,
  scope: "user",
  balancingPolicy: "conversation",
  name: "user-scoped",
  rawKey: "sk-user-scoped",
});

function testSchedulesPerKeyAccountPair(): void {
  startHuaweiRefreshTask();
  const status = getRefreshSchedulerStatus();

  assert.equal(
    status.length,
    2,
    "一个 Key 绑定两个账号 SHALL 产生两个独立调度",
  );

  const pairs = status
    .map((s) => s.keyId + "/" + s.accountId)
    .sort()
    .join(",");
  assert.equal(
    pairs,
    [
      multiAccountKey.id + "/acc-A",
      multiAccountKey.id + "/acc-B",
    ]
      .sort()
      .join(","),
    "调度 SHALL 覆盖每个 (Key, Account) 组合",
  );

  for (const entry of status) {
    assert.equal(entry.active, true, "每个会话 SHALL 处于调度状态");
  }

  // 用户级 Key 不进入调度
  assert.ok(
    !status.some((s) => s.keyId === "sk-user-scoped"),
    "用户级 Key SHALL NOT 进入调度",
  );
  const userKey = keyStore
    .listApiKeysByUser(USER_ID)
    .find((k) => (k.scope ?? "account") === "user");
  assert.ok(userKey);
  assert.ok(
    !status.some((s) => s.keyId === userKey!.id),
    "用户级 Key SHALL NOT 进入调度",
  );

  stopHuaweiRefreshTask();
  assert.equal(
    getRefreshSchedulerStatus().length,
    0,
    "停止后 SHALL 清除全部调度",
  );
}

try {
  testSchedulesPerKeyAccountPair();
  console.log("All refresh task tests passed.");
} finally {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}
