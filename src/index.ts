import express from "express";
import type { NextFunction, Request, Response } from "express";
import { bootstrapDefaultAuth, loadPersistedAuthStore } from "./auth/store";
import {
  startHuaweiRefreshTask,
  stopHuaweiRefreshTask,
  setRefreshTaskEnabled,
} from "./auth/huawei/refresh-task";
import { loadPersistedSessions } from "./auth/huawei/session-store";
import { config } from "./config";
import { authenticateApiKey } from "./middleware/authenticate-api-key";
import { withRequestContext } from "./middleware/request-context";
import {
  authorizeHuaweiLogin,
  initiateHuaweiLogin,
  handleHuaweiCallback,
} from "./routes/huawei-auth";
import {
  listBoundProviderAccounts,
  selectDefaultProviderAccount,
  triggerProviderAccountRefresh,
  unbindProviderAccount,
} from "./routes/provider-accounts";
import { createChatCompletion, listModels } from "./routes/openai";
import { createOpenAIError } from "./utils/openai-error";

const app = express();

app.use(express.json({ limit: config.requestBodyLimit }));
app.use(withRequestContext);

loadPersistedAuthStore();
bootstrapDefaultAuth(config.defaultApiKey);
loadPersistedSessions();

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<!doctype html><html><body><h1>CodeArts Agent Proxy</h1><p>Open browser login entry:</p><p><a href="/auth/huawei/authorize">/auth/huawei/authorize</a></p><p>API: <code>POST /v1/chat/completions</code> | <code>GET /v1/models</code></p></body></html>`,
  );
});

app.get("/auth/huawei/authorize", authorizeHuaweiLogin);
app.post("/auth/huawei/login", authenticateApiKey, initiateHuaweiLogin);
app.get("/callback", handleHuaweiCallback);
app.get("/auth/callback", handleHuaweiCallback);
app.get("/v1/models", authenticateApiKey, listModels);
app.post("/v1/chat/completions", authenticateApiKey, createChatCompletion);
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
