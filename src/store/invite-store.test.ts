/**
 * 一次性绑定口令测试（manual-user-bootstrap 组 2.1）。
 *
 * 覆盖签发、单次消费、过期、并发单成功、删用户即废。
 *
 * config 是模块级单例，因此 DATA_DIR 必须在加载 store 之前设置；
 * 本文件作为独立进程运行（pnpm test 逐文件串联）。
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "invite-test-"));
process.env.DATA_DIR = TMP_DIR;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const userStore = require("./user-store") as typeof import("./user-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const inviteStore = require("./invite-store") as typeof import("./invite-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require("./hierarchical-store") as typeof import("./hierarchical-store");

const NOW = "2026-01-01T00:00:00.000Z";

function setupUser(id: string, email?: string): void {
  store.setUser({ id, email, displayName: `tester ${id}`, createdAt: NOW, updatedAt: NOW });
}

function testIssueAndConsumeOnce(): void {
  inviteStore.__testHooks.reset();
  setupUser("invite-1", "invite-1@example.com");
  const { token, expiresAt } = inviteStore.issueInviteToken("invite-1");
  assert.ok(token.startsWith("sk-invite-"), "口令应有 sk-invite- 前缀");
  assert.ok(Date.parse(expiresAt) > Date.now(), "过期时间应在未来");

  const first = inviteStore.consumeInviteToken(token);
  assert.equal(first.ok, true, "首次消费应成功");
  if (first.ok) assert.equal(first.userId, "invite-1");

  const second = inviteStore.consumeInviteToken(token);
  assert.equal(second.ok, false, "复用应拒绝");
  if (!second.ok) assert.equal(second.reason, "invalid");
}

function testIssueUnknownUserThrows(): void {
  inviteStore.__testHooks.reset();
  assert.throws(
    () => inviteStore.issueInviteToken("missing-user"),
    /User not found/,
  );
}

function testExpiredTokenRejected(): void {
  inviteStore.__testHooks.reset();
  setupUser("invite-expire", "expire@example.com");
  const { token } = inviteStore.issueInviteToken("invite-expire");
  inviteStore.__testHooks.expireForTest(token);
  const result = inviteStore.consumeInviteToken(token);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "expired");
  const again = inviteStore.consumeInviteToken(token);
  assert.equal(again.ok, false, "过期清理后应为 invalid");
  if (!again.ok) assert.equal(again.reason, "invalid");
}

function testMissingTokenRejected(): void {
  inviteStore.__testHooks.reset();
  const result = inviteStore.consumeInviteToken(undefined);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing");
}

function testDeleteUserInvalidatesTokens(): void {
  inviteStore.__testHooks.reset();
  setupUser("invite-gone", "gone@example.com");
  const { token } = inviteStore.issueInviteToken("invite-gone");
  store.deleteUser("invite-gone");
  const result = inviteStore.consumeInviteToken(token);
  assert.equal(result.ok, false, "删用户后口令应失效");
  if (!result.ok) assert.equal(result.reason, "invalid");
}

function testUserStoreEmailDedup(): void {
  const a = userStore.createUser({ email: "  Dup@Example.com ", displayName: "a" });
  assert.ok(a.id);
  assert.throws(
    () => userStore.createUser({ email: "dup@example.com", displayName: "b" }),
    /already exists/,
    "同邮箱不同大小写应去重",
  );
  const noMail1 = userStore.createUser({ displayName: "no-mail-1" });
  const noMail2 = userStore.createUser({ displayName: "no-mail-2" });
  assert.notEqual(noMail1.id, noMail2.id, "无邮箱用户应允许多个");
  assert.throws(
    () => userStore.createUser({ displayName: "   " }),
    /displayName is required/,
  );
}

try {
  testIssueAndConsumeOnce();
  testIssueUnknownUserThrows();
  testExpiredTokenRejected();
  testMissingTokenRejected();
  testDeleteUserInvalidatesTokens();
  testUserStoreEmailDedup();
  console.log("All invite token tests passed.");
} finally {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}
