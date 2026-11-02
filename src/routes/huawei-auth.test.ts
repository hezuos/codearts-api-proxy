import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import type { Request, Response } from "express";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "huawei-auth-test-"));
process.env.DATA_DIR = TMP_DIR;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const storeModule = require("../store/hierarchical-store") as typeof import("../store/hierarchical-store");
storeModule.ensureDataDirs();

import { config } from "../config";
import { setUser, getProviderAccount } from "../store/hierarchical-store";
import { issueInviteToken, __testHooks as inviteTestHooks } from "../store/invite-store";
import {
  startBrowserHuaweiLogin,
  getBrowserHuaweiLoginStatus,
  handleHuaweiCallback,
  finalizeBrowserHuaweiLogin,
  __testHooks,
} from "./huawei-auth";

interface TestResponseShape {
  statusCode: number;
  body?: unknown;
  redirectUrl?: string;
  cookiesSet: Array<{ name: string; value: string }>;
  status(code: number): TestResponseShape;
  json(body: unknown): TestResponseShape;
  redirect(statusOrUrl: number | string, maybeUrl?: string): TestResponseShape;
  cookie(name: string, value: string): TestResponseShape;
  clearCookie(): TestResponseShape;
  sendFile(): TestResponseShape;
}

function createRequest(overrides: Partial<Request> = {}): Request {
  return {
    query: {},
    params: {},
    cookies: {},
    protocol: "http",
    get(name: string) {
      if (name.toLowerCase() === "host") {
        return "127.0.0.1:1455";
      }
      return undefined;
    },
    ...overrides,
  } as Request;
}

function createResponse(): Response & TestResponseShape {
  const response: TestResponseShape = {
    statusCode: 200,
    cookiesSet: [],
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    redirect(_statusOrUrl: number | string, maybeUrl?: string) {
      this.redirectUrl =
        typeof _statusOrUrl === "string" ? _statusOrUrl : maybeUrl;
      return this;
    },
    cookie(name: string, value: string) {
      this.cookiesSet.push({ name, value });
      return this;
    },
    clearCookie() {
      return this;
    },
    sendFile() {
      return this;
    },
  };

  return response as unknown as Response & TestResponseShape;
}

function setupInviteUser(id: string): string {
  try {
    setUser({
      id,
      email: `${id}@example.com`,
      displayName: `tester ${id}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // 已存在则复用
  }
  inviteTestHooks.reset();
  return issueInviteToken(id).token;
}

async function testCreateAndPollBrowserTicket(): Promise<void> {
  __testHooks.resetLoginFlows();
  const token = setupInviteUser("invite-user-1");
  const req = createRequest({ query: { invite_token: token } });
  const res = createResponse();

  await startBrowserHuaweiLogin(req, res);

  assert.equal(res.statusCode, 200);
  const body = res.body as { ticket_id: string; login_url: string };
  assert.ok(body.ticket_id);
  assert.ok(body.login_url.includes(body.ticket_id));
  assert.equal(__testHooks.getLoginFlow(body.ticket_id)?.userId, "invite-user-1");

  const pollReq = createRequest({ params: { ticketId: body.ticket_id } });
  const pollRes = createResponse();
  getBrowserHuaweiLoginStatus(pollReq, pollRes);

  const pollBody = pollRes.body as { status: string; ticket_id: string };
  assert.equal(pollBody.ticket_id, body.ticket_id);
  assert.equal(pollBody.status, "pending");
}

async function testBrowserLoginRequiresInvite(): Promise<void> {
  __testHooks.resetLoginFlows();
  inviteTestHooks.reset();
  const res = createResponse();
  await startBrowserHuaweiLogin(createRequest(), res);
  assert.equal(res.statusCode, 400);
  const body = res.body as { error: { code: string } };
  assert.equal(body.error.code, "binding_required");
}

async function testBrowserLoginRejectsBadInvite(): Promise<void> {
  __testHooks.resetLoginFlows();
  inviteTestHooks.reset();
  const res = createResponse();
  await startBrowserHuaweiLogin(createRequest({ query: { invite_token: "sk-invite-bad" } }), res);
  assert.equal(res.statusCode, 400);
  const body = res.body as { error: { code: string } };
  assert.equal(body.error.code, "token_invalid");
}

async function testConcurrentBrowserTicketsRemainDistinct(): Promise<void> {
  __testHooks.resetLoginFlows();
  inviteTestHooks.reset();
  setUser({ id: "invite-user-a", email: "invite-user-a@example.com", displayName: "tester a", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  setUser({ id: "invite-user-b", email: "invite-user-b@example.com", displayName: "tester b", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const tokenA = issueInviteToken("invite-user-a").token;
  const tokenB = issueInviteToken("invite-user-b").token;

  const res1 = createResponse();
  await startBrowserHuaweiLogin(createRequest({ query: { invite_token: tokenA } }), res1);
  const body1 = res1.body as { ticket_id: string };
  const res2 = createResponse();
  await startBrowserHuaweiLogin(createRequest({ query: { invite_token: tokenB } }), res2);

  const body2 = res2.body as { ticket_id: string };
  assert.notEqual(body1.ticket_id, body2.ticket_id);
  assert.equal(__testHooks.getLoginFlow(body1.ticket_id)?.userId, "invite-user-a");
  assert.equal(__testHooks.getLoginFlow(body2.ticket_id)?.userId, "invite-user-b");
}

async function testExpiredTicketStatus(): Promise<void> {
  __testHooks.resetLoginFlows();
  const ticketId = "expired-ticket";
  __testHooks.setLoginFlow({
    ticketId,
    loginUrl: "http://example/login",
    state: "state",
    expiresAt: Date.now() - 1,
    userId: "user-1",
    kind: "browser",
    browserStatus: "pending",
  });

  const res = createResponse();
  getBrowserHuaweiLoginStatus(
    createRequest({ params: { ticketId } }),
    res,
  );

  const body = res.body as { status: string };
  assert.equal(body.status, "expired");
}

async function testUnknownCallbackRejectedSafely(): Promise<void> {
  __testHooks.resetLoginFlows();
  __testHooks.setExchangeHuaweiTicketForTest(async () => {
    throw new Error("not matched");
  });

  const res = createResponse();
  await handleHuaweiCallback(
    createRequest({ query: { identifier: "identifier-1" } }),
    res,
  );

  assert.equal(res.statusCode, 400);
  const body = res.body as { error: { message: string } };
  assert.equal(body.error.message, "Unknown or expired login flow");

  __testHooks.resetExchangeHuaweiTicketForTest();
}

async function testOAuth2CallbackMatchesState(): Promise<void> {
  __testHooks.resetLoginFlows();
  inviteTestHooks.reset();
  setUser({ id: "oauth-user-a", email: "oauth-user-a@example.com", displayName: "a", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  setUser({ id: "oauth-user-b", email: "oauth-user-b@example.com", displayName: "b", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const tokenA = issueInviteToken("oauth-user-a").token;
  const inviteB = issueInviteToken("oauth-user-b").token;

  const resA = createResponse();
  await startBrowserHuaweiLogin(createRequest({ query: { invite_token: tokenA } }), resA);
  const flowA = (resA.body as { ticket_id: string }).ticket_id;
  const resB = createResponse();
  await startBrowserHuaweiLogin(createRequest({ query: { invite_token: inviteB } }), resB);
  const flowB = (resB.body as { ticket_id: string }).ticket_id;

  // 未知 state 应拒绝，不落到最近 flow
  const badRes = createResponse();
  await handleHuaweiCallback(
    createRequest({ query: { code: "code-x", state: "no-such-state" } }),
    badRes,
  );
  assert.equal(badRes.statusCode, 400);
  assert.ok(__testHooks.getLoginFlow(flowA));
  assert.ok(__testHooks.getLoginFlow(flowB));
}

async function testAccountConflictAcrossUsers(): Promise<void> {
  __testHooks.resetLoginFlows();
  try {
    setUser({ id: "conflict-a", email: "a-conflict@example.com", displayName: "a", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  } catch { /* 已存在 */ }
  try {
    setUser({ id: "conflict-b", email: "b-conflict@example.com", displayName: "b", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  } catch { /* 已存在 */ }
  __testHooks.setExchangeHuaweiTicketForTest(async () => ({
    userId: "u",
    userName: "Huawei User",
    domainId: "shared-domain",
    businessToken: "t",
    credentials: { accessKey: "ak", secretKey: "sk", securityToken: "st", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    raw: {},
  }));
  __testHooks.setLoginFlow({
    ticketId: "ticket-a",
    loginUrl: "http://example/a",
    state: "ticket-a",
    expiresAt: Date.now() + 60_000,
    userId: "conflict-a",
    kind: "browser",
    browserStatus: "pending",
  });
  __testHooks.setLoginFlow({
    ticketId: "ticket-b",
    loginUrl: "http://example/b",
    state: "ticket-b",
    expiresAt: Date.now() + 60_000,
    userId: "conflict-b",
    kind: "browser",
    browserStatus: "pending",
  });
  const resA = createResponse();
  await handleHuaweiCallback(createRequest({ query: { identifier: "id-a" }, cookies: { huawei_login_ticket: "ticket-a" } }), resA);
  await __testHooks.waitForBrowserExchangeTask("ticket-a");
  const owner = getProviderAccount("huawei-shared-domain");
  assert.ok(owner, "首个用户应成功绑定");
  assert.equal(owner?.userId, "conflict-a");

  // 同一华为账号被第二个用户登录应冲突：不新增 Key/Session，归属不变
  const resB = createResponse();
  await handleHuaweiCallback(createRequest({ query: { identifier: "id-b" }, cookies: { huawei_login_ticket: "ticket-b" } }), resB);
  await __testHooks.waitForBrowserExchangeTask("ticket-b");
  const statusRes = createResponse();
  getBrowserHuaweiLoginStatus(createRequest({ params: { ticketId: "ticket-b" } }), statusRes);
  const statusBody = statusRes.body as { status: string; error?: string };
  assert.equal(statusBody.status, "failed");
  assert.ok(statusBody.error?.includes("already bound to another user"));
  assert.equal(getProviderAccount("huawei-shared-domain")?.userId, "conflict-a", "归属不应被抢走");
  __testHooks.resetExchangeHuaweiTicketForTest();
}

async function testCallbackReturnsImmediatelyAndFinalizeSetsCookie(): Promise<void> {
  __testHooks.resetLoginFlows();
  const token = setupInviteUser("cookie-user");
  const startRes = createResponse();
  await startBrowserHuaweiLogin(createRequest({ query: { invite_token: token } }), startRes);
  const startBody = startRes.body as { ticket_id: string };

  __testHooks.setExchangeHuaweiTicketForTest(async () => ({
    userId: "user-1",
    userName: "Huawei User",
    domainId: "domain-1",
    businessToken: "token-1",
    credentials: {
      accessKey: "ak",
      secretKey: "sk",
      securityToken: "st",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    raw: {},
  }));

  const callbackRes = createResponse();
  const allowedRedirect = `${config.huaweiRedirectHost.replace(/\/$/, "")}/continue`;
  await handleHuaweiCallback(
    createRequest({
      query: { identifier: "identifier-1", redirect: allowedRedirect },
      cookies: { huawei_login_ticket: startBody.ticket_id },
    }),
    callbackRes,
  );

  assert.equal(
    callbackRes.redirectUrl,
    allowedRedirect,
  );

  await __testHooks.waitForBrowserExchangeTask(startBody.ticket_id);

  const statusRes = createResponse();
  getBrowserHuaweiLoginStatus(
    createRequest({ params: { ticketId: startBody.ticket_id } }),
    statusRes,
  );
  const statusBody = statusRes.body as { status: string };
  assert.equal(statusBody.status, "completed");

  const finalizeRes = createResponse();
  finalizeBrowserHuaweiLogin(
    createRequest({ params: { ticketId: startBody.ticket_id } }),
    finalizeRes,
  );
  assert.equal(finalizeRes.statusCode, 200);
  assert.ok(finalizeRes.cookiesSet.some((entry) => entry.name === "auth_key"));

  __testHooks.resetExchangeHuaweiTicketForTest();
}

async function testUnsafeCallbackRedirectRejected(): Promise<void> {
  __testHooks.resetLoginFlows();
  __testHooks.setExchangeHuaweiTicketForTest(async () => {
    throw new Error("not matched");
  });

  const token = setupInviteUser("redirect-user");
  const startRes = createResponse();
  await startBrowserHuaweiLogin(createRequest({ query: { invite_token: token } }), startRes);
  const startBody = startRes.body as { ticket_id: string };

  const callbackRes = createResponse();
  await handleHuaweiCallback(
    createRequest({
      query: {
        identifier: "identifier-1",
        redirect: "https://evil.example.com/phish",
      },
      cookies: { huawei_login_ticket: startBody.ticket_id },
    }),
    callbackRes,
  );

  // 非白名单主机的 redirect 被拒绝，回退到本地完成页
  assert.equal(
    callbackRes.redirectUrl,
    `/auth/huawei/browser/complete?ticket_id=${encodeURIComponent(startBody.ticket_id)}`,
  );

  await __testHooks.waitForBrowserExchangeTask(startBody.ticket_id);
  __testHooks.resetExchangeHuaweiTicketForTest();
}

async function run(): Promise<void> {
  await testCreateAndPollBrowserTicket();
  await testBrowserLoginRequiresInvite();
  await testBrowserLoginRejectsBadInvite();
  await testConcurrentBrowserTicketsRemainDistinct();
  await testOAuth2CallbackMatchesState();
  await testAccountConflictAcrossUsers();
  await testExpiredTicketStatus();
  await testUnknownCallbackRejectedSafely();
  await testCallbackReturnsImmediatelyAndFinalizeSetsCookie();
  await testUnsafeCallbackRedirectRejected();
  console.log("All Huawei browser login tests passed.");
}

void run();
