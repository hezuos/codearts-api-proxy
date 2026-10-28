#!/usr/bin/env node
/**
 * 真实 tool call 验证脚本（v2 通道，默认 glm-5.3）。
 *
 * 通过本地代理的公开 OpenAI 兼容接口运行，不使用 mock，也不读取或解密 data/ 中的凭据。
 * 需要先启动本地代理（pnpm dev）。
 *
 * API Key 获取（自动）：
 *   1. 若设置了 OPENAI_API_KEY 且有效，直接使用；
 *   2. 否则自动发起代理浏览器登录流程（POST /auth/huawei/browser/start），
 *      自动打开浏览器让你完成华为云登录，轮询状态后 finalize 提取 auth_key。
 *
 * 场景：
 *   T1 流式首次调用 —— tool_calls 完整（name 正确、arguments 为完整 JSON、finish_reason="tool_calls"）
 *   T2 流式工具结果回传续传 —— 模型基于 tool 结果生成回答
 *   T3 非流式首次调用 —— 上游 SSE 分片按 index 合并为单个 tool_call
 *      （回归：曾被拆成多个调用，name="unknown"、arguments 碎片化）
 *   T4 非流式工具结果回传续传
 *
 * 上游并发会话上限（TM.00001041）自动退避重试。
 *
 * 运行：
 *   npm run verify:tool-call
 * 可选环境变量：OPENAI_API_KEY / OPENAI_BASE_URL / CODEARTS_TEST_MODEL（默认 glm-5.3）
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import assert from "node:assert";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string; tool_calls?: ToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

interface HttpResult {
  status: number;
  raw: string;
}

// ---------------------------------------------------------------------------
// 配置与工具
// ---------------------------------------------------------------------------

const baseUrl = (process.env.OPENAI_BASE_URL ?? "http://localhost:1455").replace(/\/$/, "");
const model = process.env.CODEARTS_TEST_MODEL ?? "glm-5.3";

const TOOLS = [
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
];

const system: Message = {
  role: "system",
  content: "需要天气信息时必须调用 get_weather 工具，不要直接回答。",
};

function newChatId(): string {
  return randomBytes(16).toString("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// API Key 自动获取
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  // 仅放行解析合法的 http(s) URL；非 URL 值不交给系统打开命令（CWE-78 纵深防御）。
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return;
  }
  const href = target.href;
  if (process.platform === "win32") {
    // explorer.exe 不是 shell、不解释 & 等元字符（cmd /c start 会被注入）。
    execFile("explorer.exe", [href], () => {
      /* 忽略打开失败（explorer 成功时也返回非零退出码） */
    });
  } else if (process.platform === "darwin") {
    execFile("open", [href], () => {
      /* 忽略打开失败 */
    });
  } else {
    execFile("xdg-open", [href], () => {
      /* 忽略打开失败 */
    });
  }
}

async function modelsOk(key: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 自动获取有效 API Key：
 * 1) env 已有且有效 → 直接返回；2) 否则走代理浏览器登录流程。
 */
async function obtainApiKey(): Promise<string> {
  const envKey = process.env.OPENAI_API_KEY ?? "";
  if (envKey && (await modelsOk(envKey))) {
    console.log("使用已提供的 OPENAI_API_KEY。");
    return envKey;
  }

  console.log("未发现可用 API Key，启动自动登录获取…（请在浏览器完成华为云登录）");
  const start = await fetch(`${baseUrl}/auth/huawei/browser/start`, { method: "POST" });
  if (!start.ok) {
    const raw = await start.text();
    throw new Error(`启动浏览器登录失败: HTTP ${start.status} ${raw.slice(0, 300)}`);
  }
  const flow = (await start.json()) as {
    ticket_id: string;
    login_url: string;
    status_url: string;
    expires_at: string;
  };
  console.log(`登录地址（已尝试自动打开，未打开请手动访问）：\n  ${flow.login_url}`);
  openBrowser(flow.login_url);

  const deadline = Date.now() + 180_000;
  for (;;) {
    await sleep(2000);
    if (Date.now() > deadline) {
      throw new Error("等待登录完成超时（180s）");
    }
    const statusRes = await fetch(`${baseUrl}/auth/huawei/browser/status/${flow.ticket_id}`);
    const data = (await statusRes.json()) as { status?: string; error?: string };
    if (data.status === "completed") break;
    if (data.status === "failed" || data.status === "expired") {
      throw new Error(`登录失败: ${data.error ?? data.status}`);
    }
  }

  const finalize = await fetch(`${baseUrl}/auth/huawei/browser/finalize/${flow.ticket_id}`, {
    method: "POST",
  });
  // auth_key cookie 已改为加密存储；finalize 响应体直接返回 api_key（仅持票者可得）。
  if (!finalize.ok) {
    const raw = await finalize.text();
    throw new Error(`登录完成但 finalize 失败: HTTP ${finalize.status} ${raw.slice(0, 300)}`);
  }
  const finalizeBody = (await finalize.json()) as { api_key?: string };
  const key = finalizeBody.api_key;
  if (!key) {
    throw new Error("登录完成但 finalize 未返回 api_key");
  }
  console.log("已获取 API Key。");
  return key;
}

// ---------------------------------------------------------------------------
// OpenAI 兼容请求（含 TM.00001041 并发会话上限退避重试）
// ---------------------------------------------------------------------------

async function post(apiKey: string, body: Record<string, unknown>): Promise<HttpResult> {
  const stream = body.stream === true;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    // 上游并发会话数已达上限（TM.00001041）：退避重试
    if (res.status === 502 && raw.includes("TM.00001041") && attempt < 3) {
      await sleep(5000 * attempt);
      continue;
    }
    return { status: res.status, raw };
  }
  throw new Error("unreachable");
}

/** 解析 SSE：content 拼接、tool_calls 按 index 合并。 */
function parseStream(raw: string): {
  finish_reason: string | null;
  content: string;
  tool_calls: ToolCall[];
} {
  const content: string[] = [];
  const toolCalls: Array<ToolCall | undefined> = [];
  let finishReason: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    let chunk: {
      choices?: Array<{
        finish_reason?: string | null;
        delta?: {
          content?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue; // 忽略畸形行
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (choice.delta?.content) content.push(choice.delta.content);
    for (const tc of choice.delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      toolCalls[idx] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
      const acc = toolCalls[idx]!;
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.function.name += tc.function.name;
      if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
    }
  }
  return { finish_reason: finishReason, content: content.join(""), tool_calls: toolCalls.filter(Boolean) as ToolCall[] };
}

function requestBody(
  chatId: string,
  messages: Message[],
  stream: boolean,
): Record<string, unknown> {
  return { model, stream, messages, tools: TOOLS, codearts: { chat_id: chatId } };
}

/** 断言单个 tool_call 完整：name 正确、arguments 可解析且含 city。 */
function assertSingleWeatherCall(label: string, toolCalls: ToolCall[]): ToolCall {
  assert.equal(
    toolCalls.length,
    1,
    `${label}: 应合并为 1 个 tool_call，实际 ${toolCalls.length} 个（上游分片未按 index 合并？）`,
  );
  const tc = toolCalls[0]!;
  assert.equal(tc.function.name, "get_weather", `${label}: tool_call name 应为 get_weather，实际 ${tc.function.name}`);
  const args = JSON.parse(tc.function.arguments) as { city?: unknown };
  assert.ok(typeof args.city === "string" && args.city.length > 0, `${label}: arguments 应为完整 JSON 且含 city`);
  return tc;
}

// ---------------------------------------------------------------------------
// 主流程（T1-T4）
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const apiKey = await obtainApiKey();

  // ── T1：流式首次调用 ──────────────────────────────────────────────────────
  const c1 = newChatId();
  const t1User: Message = { role: "user", content: "查一下深圳的天气，用工具。" };
  const r1 = await post(apiKey, requestBody(c1, [system, t1User], true));
  assert.equal(r1.status, 200, `T1 HTTP ${r1.status}: ${r1.raw.slice(0, 300)}`);
  const s1 = parseStream(r1.raw);
  assert.equal(s1.finish_reason, "tool_calls", `T1: finish_reason 应为 tool_calls，实际 ${s1.finish_reason}`);
  const t1Call = assertSingleWeatherCall("T1", s1.tool_calls);
  const t1Args = JSON.parse(t1Call.function.arguments) as { city: string };
  console.log(JSON.stringify({ scenario: "T1-stream-tool-call", finish_reason: s1.finish_reason, tool_calls: s1.tool_calls }));

  // ── T2：流式工具结果回传续传 ───────────────────────────────────────────────
  const t2Tool: Message = {
    role: "tool",
    tool_call_id: t1Call.id,
    name: "get_weather",
    content: JSON.stringify({ city: t1Args.city, weather: "多云", temperature_c: 28 }),
  };
  const r2 = await post(
    apiKey,
    requestBody(
      c1,
      [system, t1User, { role: "assistant", content: s1.content, tool_calls: s1.tool_calls }, t2Tool],
      true,
    ),
  );
  assert.equal(r2.status, 200, `T2 HTTP ${r2.status}: ${r2.raw.slice(0, 300)}`);
  const s2 = parseStream(r2.raw);
  assert.ok(s2.content.trim().length > 0, "T2: 工具结果回传后应生成文本回答");
  if (s2.finish_reason !== "stop") {
    console.log(JSON.stringify({ scenario: "T2-warn", note: `finish_reason=${s2.finish_reason}（期望 stop）` }));
  }
  console.log(JSON.stringify({ scenario: "T2-stream-continuation", finish_reason: s2.finish_reason, content_preview: s2.content.slice(0, 120) }));

  // ── T3：非流式首次调用（分片合并回归）─────────────────────────────────────
  const c3 = newChatId();
  const r3 = await post(
    apiKey,
    requestBody(c3, [system, { role: "user", content: "查一下杭州的天气，用工具。" }], false),
  );
  assert.equal(r3.status, 200, `T3 HTTP ${r3.status}: ${r3.raw.slice(0, 300)}`);
  const j3 = JSON.parse(r3.raw) as ChatResponse;
  const msg3 = j3.choices?.[0]?.message ?? {};
  assert.equal(
    j3.choices?.[0]?.finish_reason,
    "tool_calls",
    `T3: 有 tool_calls 时 finish_reason 必须为 tool_calls，实际 ${j3.choices?.[0]?.finish_reason}`,
  );
  const t3Call = assertSingleWeatherCall("T3", msg3.tool_calls ?? []);
  const t3Args = JSON.parse(t3Call.function.arguments) as { city: string };
  console.log(JSON.stringify({ scenario: "T3-nonstream-tool-call", finish_reason: j3.choices?.[0]?.finish_reason, tool_calls: msg3.tool_calls }));

  // ── T4：非流式工具结果回传续传 ─────────────────────────────────────────────
  const t4Tool: Message = {
    role: "tool",
    tool_call_id: t3Call.id,
    name: "get_weather",
    content: JSON.stringify({ city: t3Args.city, weather: "小雨", temperature_c: 21 }),
  };
  const r4 = await post(
    apiKey,
    requestBody(
      c3,
      [
        system,
        { role: "user", content: "查一下杭州的天气，用工具。" },
        { role: "assistant", content: msg3.content ?? "", tool_calls: msg3.tool_calls },
        t4Tool,
      ],
      false,
    ),
  );
  assert.equal(r4.status, 200, `T4 HTTP ${r4.status}: ${r4.raw.slice(0, 300)}`);
  const j4 = JSON.parse(r4.raw) as ChatResponse;
  const msg4 = j4.choices?.[0]?.message ?? {};
  const t4HasContent = (msg4.content ?? "").trim().length > 0;
  assert.ok(
    t4HasContent || (msg4.tool_calls?.length ?? 0) > 0,
    "T4: 工具结果回传后应有文本回答或进一步工具调用",
  );
  console.log(JSON.stringify({ scenario: "T4-nonstream-continuation", finish_reason: j4.choices?.[0]?.finish_reason, content_preview: String(msg4.content ?? "").slice(0, 120) }));

  console.log(JSON.stringify({ ok: true, note: "T1-T4 全部通过。" }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
