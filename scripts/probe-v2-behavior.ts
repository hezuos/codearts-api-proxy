/**
 * 探针：v2 上游关键行为验证（一次性）。
 *
 * R1: 建立暗号（全量历史形态的第一轮）
 * R2: 只发新问题（增量形态，无历史）——测上游是否有跨请求会话状态
 * R3: 全量历史对照——应能答出暗号
 * R4: 子代理字段（isSubAgent/subAgent_type/subAgent_prompt）——测参数接受度
 * R5: 工具调用——测上游是否发射标准 tool_calls
 *
 * 用法：pnpm exec ts-node scripts/probe-v2-behavior.ts
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

interface ProbeChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: unknown;
  error_code?: string;
  error_msg?: string;
}

function analyze(chunks: string[]): {
  text: string;
  reasoning: string;
  toolCalls: string;
  hasUsage: boolean;
  error?: string;
} {
  let text = "";
  let reasoning = "";
  let toolCalls = "";
  let hasUsage = false;
  let error: string | undefined;
  for (const line of chunks.join("").split("\n")) {
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") continue;
    try {
      const o = JSON.parse(json) as ProbeChunk;
      const d = o.choices?.[0]?.delta;
      const c = d?.content;
      if (typeof c === "string") text += c;
      const rc = d?.reasoning_content;
      if (typeof rc === "string") reasoning += rc;
      if (d?.tool_calls) {
        for (const tc of d.tool_calls) {
          const id = tc.id;
          if (id) toolCalls += `[id:${id}]`;
          const fname = tc.function?.name;
          if (fname) toolCalls += `[name:${fname}]`;
          const fargs = tc.function?.arguments;
          if (fargs) toolCalls += fargs;
        }
      }
      if (o.usage) hasUsage = true;
      if (o.error_code && o.error_code !== "0" && o.error_code !== "ChatAgent.00000000") {
        error = `${o.error_code}: ${o.error_msg ?? ""}`;
      }
    } catch { /* ignore malformed */ }
  }
  return { text, reasoning, toolCalls, hasUsage, error };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const keyIds = listSessionKeyIds();
  if (keyIds.length === 0) {
    console.error("no sessions");
    process.exit(1);
  }
  let session = getSession(keyIds[0])!;
  const expiresAt = Number(session.expiresAt);
  if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
    const refreshed = await refreshStoredSession(keyIds[0]);
    if (refreshed) session = refreshed;
  }
  const credentials = getCredentials(session);
  const v2Url = `${config.huaweiChatHost}/api/v2/chat/completions`;
  console.log(`端点: ${v2Url}`);
  console.log(`AK: ${credentials.accessKey.slice(0, 8)}...\n`);

  const WAIT_MS = 35_000;

  async function ask(label: string, body: Record<string, unknown>): Promise<void> {
    const bodyJson = JSON.stringify(body);
    const headers = buildV2Headers(v2Url, bodyJson, credentials, randomUUID().replace(/-/g, "").slice(0, 16));
    console.log(`──────── ${label} ────────`);
    try {
      const r = await postAndStream(v2Url, headers, bodyJson);
      const a = analyze(r.chunks);
      console.log(`  HTTP ${r.status}${a.error ? `  ERR: ${a.error}` : ""}`);
      if (a.reasoning) console.log(`  reasoning(${a.reasoning.length}字): ${a.reasoning.slice(0, 60)}...`);
      if (a.text) console.log(`  content: ${a.text.slice(0, 120)}`);
      if (a.toolCalls) console.log(`  toolCalls: ${a.toolCalls.slice(0, 200)}`);
      console.log(`  usage chunk: ${a.hasUsage}`);
    } catch (e) {
      console.log(`  异常: ${e instanceof Error ? e.message : String(e)}`);
    }
    console.log();
    await sleep(WAIT_MS);
  }

  const base = { model: "glm-5.3", max_tokens: 65536, tool_stream: true, stream: true };

  await ask("R1 建立暗号", {
    ...base,
    messages: [{ role: "user", content: "我的暗号是：西瓜42号。请只回复两个字：收到" }],
  });

  await ask("R2 增量形态（无历史，测上游状态）", {
    ...base,
    messages: [{ role: "user", content: "我的暗号是多少？只回答暗号内容；不知道就回答：不知道" }],
  });

  await ask("R3 全量历史对照", {
    ...base,
    messages: [
      { role: "user", content: "我的暗号是：西瓜42号。请只回复两个字：收到" },
      { role: "assistant", content: "收到" },
      { role: "user", content: "我的暗号是多少？只回答暗号内容；不知道就回答：不知道" },
    ],
  });

  await ask("R4 子代理字段", {
    ...base,
    isSubAgent: true,
    subAgent_type: "Explore",
    subAgent_prompt: "你是代码探索助手",
    messages: [{ role: "user", content: "请只回复四个字：子代理正常" }],
  });

  await ask("R5 工具调用", {
    ...base,
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "查询指定城市的天气",
          parameters: {
            type: "object",
            properties: { city: { type: "string", description: "城市名" } },
            required: ["city"],
          },
        },
      },
    ],
    messages: [{ role: "user", content: "请调用 get_weather 工具查询北京的天气" }],
  });

  console.log("PROBE DONE");
})().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
