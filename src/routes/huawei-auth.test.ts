import assert from "assert";
import type { Request, Response } from "express";
import { config } from "../config";
import { bootstrapDefaultAuth } from "../auth/store";
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

async function testCreateAndPollBrowserTicket(): Promise<void> {
  __testHooks.resetLoginFlows();
  const req = createRequest();
  const res = createResponse();

  await startBrowserHuaweiLogin(req, res);

  assert.equal(res.statusCode, 200);
  const body = res.body as { ticket_id: string; login_url: string };
  assert.ok(body.ticket_id);
  assert.ok(body.login_url.includes(body.ticket_id));

  const pollReq = createRequest({ params: { ticketId: body.ticket_id } });
  const pollRes = createResponse();
  getBrowserHuaweiLoginStatus(pollReq, pollRes);

  const pollBody = pollRes.body as { status: string; ticket_id: string };
  assert.equal(pollBody.ticket_id, body.ticket_id);
  assert.equal(pollBody.status, "pending");
}

async function testConcurrentBrowserTicketsRemainDistinct(): Promise<void> {
  __testHooks.resetLoginFlows();

  const res1 = createResponse();
  await startBrowserHuaweiLogin(createRequest(), res1);
  const res2 = createResponse();
  await startBrowserHuaweiLogin(createRequest(), res2);

  const body1 = res1.body as { ticket_id: string };
  const body2 = res2.body as { ticket_id: string };
  assert.notEqual(body1.ticket_id, body2.ticket_id);
  assert.ok(__testHooks.getLoginFlow(body1.ticket_id));
  assert.ok(__testHooks.getLoginFlow(body2.ticket_id));
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

async function testCallbackReturnsImmediatelyAndFinalizeSetsCookie(): Promise<void> {
  __testHooks.resetLoginFlows();
  const startRes = createResponse();
  await startBrowserHuaweiLogin(createRequest(), startRes);
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

  const startRes = createResponse();
  await startBrowserHuaweiLogin(createRequest(), startRes);
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
  bootstrapDefaultAuth();
  await testCreateAndPollBrowserTicket();
  await testConcurrentBrowserTicketsRemainDistinct();
  await testExpiredTicketStatus();
  await testUnknownCallbackRejectedSafely();
  await testCallbackReturnsImmediatelyAndFinalizeSetsCookie();
  await testUnsafeCallbackRedirectRejected();
  console.log("All Huawei browser login tests passed.");
}

void run();
