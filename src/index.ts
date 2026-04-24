import express from "express";
import fs from "fs";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import type { NextFunction, Request, Response } from "express";
import { bootstrapDefaultAuth, loadPersistedAuthStore } from "./auth/store";
import {
  startHuaweiRefreshTask,
  stopHuaweiRefreshTask,
  setRefreshTaskEnabled,
} from "./auth/huawei/refresh-task";
import { loadAdminConfig } from "./auth/admin";
import { config, rateLimitChatMax, rateLimitModelsMax } from "./config";
import { authenticateApiKey } from "./middleware/authenticate-api-key";
import { withRequestContext } from "./middleware/request-context";
import { requireUiAuth } from "./middleware/authenticate-ui";
import { requireAdminAuth } from "./middleware/authenticate-admin";
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

const app = express();

app.use(cookieParser());
app.use(express.json({ limit: config.requestBodyLimit }));
app.use(express.static("public"));
app.use(withRequestContext);

loadPersistedAuthStore();
  bootstrapDefaultAuth();
loadAdminConfig();

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Readiness probe — checks if the system can process requests
app.get("/ready", (_req, res) => {
  try {
    const testFile = `${config.dataDir}/.ready-check`;
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
    res.json({ status: "ok", checks: { store: true } });
  } catch {
    res.status(503).json({ status: "degraded", checks: { store: false } });
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
app.post("/api/ui/regenerate-key", requireUiAuth, regenerateApiKey);
app.post(
  "/api/ui/accounts/:accountId/refresh",
  requireUiAuth,
  refreshAccountToken,
);
app.delete("/api/ui/accounts/:accountId", requireUiAuth, unbindAccount);
app.post(
  "/api/ui/accounts/:accountId/default",
  requireUiAuth,
  setDefaultAccount,
);

// Admin routes
app.get("/admin/setup", adminSetupPage);
app.post("/admin/setup", adminSetup);
app.get("/admin/login", adminLoginPage);
app.post("/admin/login", adminLogin);
app.post("/admin/logout", adminLogout);
app.get("/admin", requireAdminAuth, adminPanel);
app.get("/admin/api/users", requireAdminAuth, getAllUsers);
app.get("/admin/api/accounts", requireAdminAuth, getAllAccounts);
app.get("/admin/api/accounts/:id", requireAdminAuth, getAccountDetails);
app.post("/admin/api/keys/:id/revoke", requireAdminAuth, revokeApiKey);
app.delete("/admin/api/keys/:id", requireAdminAuth, deleteApiKey);
app.post("/admin/api/keys/:id/refresh", requireAdminAuth, refreshApiKey);
app.post(
  "/admin/api/accounts/:id/refresh",
  requireAdminAuth,
  forceRefreshAccount,
);
app.delete("/admin/api/accounts/:id", requireAdminAuth, deleteAccount);

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
  console.log(`CodeArts Agent Proxy listening on :${config.port}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  console.log(`\n${signal} received — shutting down...`);
  stopHuaweiRefreshTask();
  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0);
  });
  // Force exit after 5 seconds if server doesn't close
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
