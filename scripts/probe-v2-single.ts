/**
 * 单请求探针：只发一个请求，避免并发槽位干扰。
 * 用法：pnpm exec ts-node scripts/probe-v2-single.ts <max_tokens> [contentLen]
 */

import { randomUUID } from "crypto";
import https from "https";

import { config } from "../src/config";
import { loadPersistedAuthStore } from "../src/store/user-store";
import { listSessionKeyIds, getSession, refreshStoredSession } from "../src/auth/huawei/session-store";
import { getCredentials, signRequest } from "../src/auth/huawei/credentials";

loadPersistedAuthStore();

function postAndStream(
  url: string,
  hdrs: Record<string, string>,
  payload: string,
): Promise<{ status: number; chunks: string[] }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: { ...hdrs, "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: string[] = [];
        res.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, chunks }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(120_000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(payload);
    req.end();
  });
}

function buildV2Headers(
  url: string,
  body: string,
  credentials: ReturnType<typeof getCredentials>,
  traceId: string,
): Record<string, string> {
  const extra: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Agent-Type": "ChatAgent",
    "X-Language": "zh-CN",
    "x-snap-traceid": traceId,
    client_version: config.pluginVersion,
    "plugin-name": "codearts-snap_vscode",
    "plugin-version": config.pluginVersion,
    "ide-name": "CodeArts Agent",
    "ide-version": config.ideVersion,
    is_confidential: "false",
    "heartbeat-enable": "true",
  };
  const signed = signRequest(
    { method: "POST", url, headers: { "Content-Type": "application/json" }, body },
    credentials,
  );
  return { ...extra, ...signed };
}

(async () => {
  const maxTokens = Number(process.argv[2] ?? 32000);
  const contentLen = Number(process.argv[3] ?? 0);

  const keyIds = listSessionKeyIds();
  let session = getSession(keyIds[0])!;
  const expiresAt = Number(session.expiresAt);
  if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
    const refreshed = await refreshStoredSession(keyIds[0]);
    if (refreshed) session = refreshed;
  }
  const credentials = getCredentials(session);
  const v2Url = `${config.huaweiChatHost}/api/v2/chat/completions`;

  const body = {
    model: "glm-5.3",
    max_tokens: maxTokens,
    tool_stream: true,
    stream: true,
    messages: [{ role: "user", content: contentLen > 0 ? "x".repeat(contentLen) : "回复 OK" }],
  };
  const bodyJson = JSON.stringify(body);
  const traceId = randomUUID().replace(/-/g, "").slice(0, 16);
  const headers = buildV2Headers(v2Url, bodyJson, credentials, traceId);

  console.log(`max_tokens=${maxTokens} contentLen=${contentLen} bytes=${bodyJson.length}`);
  const result = await postAndStream(v2Url, headers, bodyJson);
  const joined = result.chunks.join("");
  console.log(`HTTP ${result.status}`);
  console.log(joined.slice(0, 600));
})();