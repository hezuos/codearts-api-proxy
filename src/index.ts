// 统一 env 加载入口（副作用模块）：必须最先加载，保证 .env 注入早于任何模块级读 env
import "./env";
import express from "express";
import fs from "fs";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import type { NextFunction, Request, Response } from "express";
import { APP_VERSION, GIT_COMMIT, BUILD_TIME } from "./version";
import { bootstrapDefaultAuth, loadPersistedAuthStore } from "./auth/store";
import {
  startHuaweiRefreshTask,
  stopHuaweiRefreshTask,
  setRefreshTaskEnabled,
} from "./auth/huawei/refresh-task";
import { loadAdminConfig } from "./auth/admin";
import { config, rateLimitChatMax, rateLimitModelsMax, rateLimitGlobalMax, isDevEncryptionKey } from "./config";
import { authenticateApiKey } from "./middleware/authenticate-api-key";
import { withRequestContext } from "./middleware/request-context";
import { requireUiAuth } from "./middleware/authenticate-ui";
import { requireAdminAuth } from "./middleware/authenticate-admin";
import { issueCsrfCookie, verifyCsrfToken } from "./middleware/csrf";
import {
  authorizeHuaweiLogin,
  initiateHuaweiLogin,
  handleHuaweiCallback,
  startBrowserHuaweiLogin,
  getBrowserHuaweiLoginStatus,
  finalizeBrowserHuaweiLogin,
} from "./routes/huawei-auth";
import {
  listBoundProviderAccounts,
  selectDefaultProviderAccount,
  triggerProviderAccountRefresh,
  unbindProviderAccount,
} from "./routes/provider-accounts";
import { createChatCompletion, listModels } from "./routes/openai";
import {
  successPage,
  getAccountInfo,
  getAccountStatus,
  getLoginResult,
  regenerateApiKey,
  refreshAccountToken,
  unbindAccount,
  setDefaultAccount,
} from "./routes/web-ui";
import {
  adminSetupPage,
  adminSetup,
  adminLoginPage,
  adminLogin,
  adminLogout,
  adminPanel,
  getAllUsers,
  getAllAccounts,
  getAccountDetails,
  revokeApiKey,
  deleteApiKey,
  refreshApiKey,
  forceRefreshAccount,
  deleteAccount,
} from "./routes/admin";
import { createOpenAIError } from "./utils/openai-error";
import { logger, closeLogger } from "./utils/logger";

const app = express();

app.use(cookieParser());
// 双提交 CSRF：尽早下发 csrf_token cookie（可被前端 JS 读取），供 fetch 回传 x-csrf-token。
app.use(issueCsrfCookie);
app.use(express.json({ limit: config.requestBodyLimit }));
app.use(express.static("public"));
app.use(withRequestContext);

// 全局 IP 限流：兜底覆盖所有无专用限流器的路由（/ready、OAuth 回调、Web UI、Admin 只读等）。
// /v1/chat、/v1/models、/admin/login 等已有专用限流器的路由为双计数（全局 + 专用）。
const globalLimiter = rateLimit({
  windowMs: 60_000,
  max: rateLimitGlobalMax,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

loadPersistedAuthStore();
bootstrapDefaultAuth();
loadAdminConfig();

if (isDevEncryptionKey && fs.existsSync(config.dataDir) && fs.readdirSync(config.dataDir).length > 0) {
  logger.warn("Using hardcoded dev encryption key with existing data — set ENCRYPTION_KEY for security");
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: APP_VERSION, gitCommit: GIT_COMMIT, buildTime: BUILD_TIME });
});

// Readiness probe — checks if the system can process requests
app.get("/ready", (_req, res) => {
  try {
    const testFile = `${config.dataDir}/.ready-check`;
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
    res.json({ status: "ok", version: APP_VERSION, gitCommit: GIT_COMMIT, buildTime: BUILD_TIME, checks: { store: true } });
  } catch {
    res.status(503).json({ status: "degraded", version: APP_VERSION, gitCommit: GIT_COMMIT, buildTime: BUILD_TIME, checks: { store: false } });
  }
});

app.get("/", (_req, res) => {
  res.sendFile("index.html", { root: "public" });
});

// OAuth routes
app.get("/auth/huawei/authorize", authorizeHuaweiLogin);
app.post("/auth/huawei/browser/start", startBrowserHuaweiLogin);
app.get("/auth/huawei/browser/status/:ticketId", getBrowserHuaweiLoginStatus);
app.post("/auth/huawei/browser/finalize/:ticketId", finalizeBrowserHuaweiLogin);
app.post("/auth/huawei/login", authenticateApiKey, initiateHuaweiLogin);
app.get("/callback", handleHuaweiCallback);
app.get("/auth/callback", handleHuaweiCallback);
app.get("/oauth/callback", handleHuaweiCallback);

// Admin rate limiter for unauthenticated endpoints (IP-based, prevents brute force)
const adminLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

// API routes with rate limiting (keyed by API Key ID)
const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: rateLimitChatMax,
  keyGenerator: (req) => req.auth?.apiKeyId ?? "anonymous",
  standardHeaders: true,
  legacyHeaders: false,
});

const modelsLimiter = rateLimit({
  windowMs: 60_000,
  max: rateLimitModelsMax,
  keyGenerator: (req) => req.auth?.apiKeyId ?? "anonymous",
  standardHeaders: true,
  legacyHeaders: false,
});

app.get("/v1/models", authenticateApiKey, modelsLimiter, listModels);
app.post("/v1/chat/completions", authenticateApiKey, chatLimiter, createChatCompletion);
app.get("/provider-accounts", authenticateApiKey, listBoundProviderAccounts);
app.post(
  "/provider-accounts/:providerAccountId/default",
  authenticateApiKey,
  selectDefaultProviderAccount,
);
app.delete(
  "/provider-accounts/:providerAccountId",
  authenticateApiKey,
  unbindProviderAccount,
);
app.post(
  "/provider-accounts/:providerAccountId/refresh",
  authenticateApiKey,
  triggerProviderAccountRefresh,
);

// Web UI routes
app.get("/success", requireUiAuth, successPage);
app.get("/api/ui/account", requireUiAuth, getAccountInfo);
app.get("/api/ui/status", requireUiAuth, getAccountStatus);
app.get("/api/ui/login-result", requireUiAuth, getLoginResult);
app.post("/api/ui/regenerate-key", requireUiAuth, verifyCsrfToken, regenerateApiKey);
app.post(
  "/api/ui/accounts/:accountId/refresh",
  requireUiAuth,
  verifyCsrfToken,
  refreshAccountToken,
);
app.delete("/api/ui/accounts/:accountId", requireUiAuth, verifyCsrfToken, unbindAccount);
app.post(
  "/api/ui/accounts/:accountId/default",
  requireUiAuth,
  verifyCsrfToken,
  setDefaultAccount,
);

// Admin routes
app.get("/admin/setup", adminSetupPage);
app.post("/admin/setup", adminLimiter, verifyCsrfToken, adminSetup);
app.get("/admin/login", adminLoginPage);
app.post("/admin/login", adminLimiter, verifyCsrfToken, adminLogin);
app.post("/admin/logout", verifyCsrfToken, adminLogout);
app.get("/admin", requireAdminAuth, adminPanel);
app.get("/admin/api/users", requireAdminAuth, getAllUsers);
app.get("/admin/api/accounts", requireAdminAuth, getAllAccounts);
app.get("/admin/api/accounts/:id", requireAdminAuth, getAccountDetails);
app.post("/admin/api/keys/:id/revoke", requireAdminAuth, verifyCsrfToken, revokeApiKey);
app.delete("/admin/api/keys/:id", requireAdminAuth, verifyCsrfToken, deleteApiKey);
app.post("/admin/api/keys/:id/refresh", requireAdminAuth, verifyCsrfToken, refreshApiKey);
app.post(
  "/admin/api/accounts/:id/refresh",
  requireAdminAuth,
  verifyCsrfToken,
  forceRefreshAccount,
);
app.delete("/admin/api/accounts/:id", requireAdminAuth, verifyCsrfToken, deleteAccount);

app.use(
  (
    error: Error & { type?: string; status?: number },
    _req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (error.type === "entity.too.large" || error.status === 413) {
      res
        .status(413)
        .json(
          createOpenAIError(
            `Request body too large. Current limit is ${config.requestBodyLimit}.`,
            "invalid_request_error",
            "request_too_large",
          ),
        );
      return;
    }
    next(error);
  },
);

setRefreshTaskEnabled(config.enableRefreshTask);
startHuaweiRefreshTask();

const server = app.listen(config.port, () => {
  logger.info(`CodeArts Agent Proxy listening on :${config.port}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  logger.info(`${signal} received — shutting down...`);
  stopHuaweiRefreshTask();
  server.close(() => {
    logger.info("HTTP server closed.");
    closeLogger();
    process.exit(0);
  });
  // Force exit after 5 seconds if server doesn't close
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
