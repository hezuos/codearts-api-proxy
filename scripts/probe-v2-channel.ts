/**
 * 一次性探针：实测 /api/v2/chat/completions 通道。
 *
 * 背景：IDE 的 glm-5.3 走 {chatDomain}/api/v2/chat/completions（OpenAI 兼容），
 *       而本项目代理走 /v1/chat/chat（CodeArts 原生），glm-5.3 报 00001007。
 *
 * 目的：
 *   1. 验证 /api/v2/chat/completions 是否可用
 *   2. 验证鉴权方式（AK/SK 签名 + header 是否与 /v1/chat/chat 一致）
 *   3. 验证 glm-5.3 与其他模型在该通道的表现
 *
 * 用法：pnpm exec ts-node scripts/probe-v2-channel.ts
 */

import { randomUUID } from "crypto";
import https from "https";

import { config } from "../src/config";
import { loadPersistedAuthStore } from "../src/store/user-store";
import { listSessionKeyIds, getSession, refreshStoredSession } from "../src/auth/huawei/session-store";
import { getCredentials, signRequest } from "../src/auth/huawei/credentials";
import { getProviderAccount } from "../src/auth/store";

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

/** 与 /v1/chat/chat 相同的 header 集合（含 AK/SK 签名） */
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
    {
      method: "POST",
      url,
      headers: { "Content-Type": "application/json" },
      body,
    },
    credentials,
  );

  return { ...extra, ...signed };
}

/** 从 SSE 里提取错误码 / 内容 */
function summarize(chunks: string[]): string {
  const joined = chunks.join("");
  const errs = joined.match(/"error_code":"(ChatAgent\.[0-9]+)"/g);
  if (errs) return [...new Set(errs)].join(" ");
  if (joined.includes('"content":"')) return "OK(有内容)";
  if (joined.includes('"choices"')) return "OK(OpenAI 格式)";
  return `无错误码 | 前 200 字: ${joined.slice(0, 200)}`;
}

(async () => {
  const keyIds = listSessionKeyIds();
  const keyId = keyIds[0];
  let session = getSession(keyId);
  if (!session) {
    console.error("no session");
    process.exit(1);
  }
  const expiresAt = session.expiresAt ? new Date(session.expiresAt).getTime() : NaN;
  if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
    const refreshed = await refreshStoredSession(keyId);
    if (refreshed) session = refreshed;
  }

  const credentials = getCredentials(session);
  const providerAccount = getProviderAccount(session.providerAccountId);
  const userId =
    providerAccount?.providerUserName?.trim() ||
    providerAccount?.providerUserId?.trim() ||
    session.providerAccountId;

  console.log(`AK=${credentials.accessKey.slice(0, 8)}...  user_id=${userId}`);
  console.log(`session expiresAt=${session.expiresAt ?? "none"}\n`);

  const v2Url = `${config.huaweiChatHost}/api/v2/chat/completions`;
  console.log(`目标端点: ${v2Url}\n`);

  const models = ["glm-5.3", "GLM-5.2", "deepseek-v4.1-flash"];

  for (const modelId of models) {
    const bodyJson = JSON.stringify({
      model: modelId,
      max_tokens: 32000,
      tool_stream: true,
      stream: true,
      messages: [{ role: "user", content: "回复 OK" }],
    });
    const traceId = randomUUID().replace(/-/g, "").slice(0, 16);
    const headers = buildV2Headers(v2Url, bodyJson, credentials, traceId);

    console.log(`──────── ${modelId} ────────`);
    try {
      const result = await postAndStream(v2Url, headers, bodyJson);
      console.log(`HTTP ${result.status}`);
      console.log(`  ${summarize(result.chunks)}`);
      // 打印前几行原始 SSE，便于观察格式
      const lines = result.chunks.join("").split("\n").filter((l) => l.startsWith("data:"));
      for (const l of lines.slice(0, 4)) {
        console.log(`  raw: ${l.slice(0, 300)}`);
      }
    } catch (e) {
      console.log(`  异常: ${e instanceof Error ? e.message : String(e)}`);
    }
    console.log();
  }
})();