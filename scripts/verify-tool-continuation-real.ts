#!/usr/bin/env node
/**
 * 真实 CodeArts「会话消息传递」验证脚本（fix-tool-continuation-fallback / S 系列）。
 *
 * 通过本地代理的公开 OpenAI 兼容接口运行，不使用 mock，也不读取或解密 data/ 中的凭据。
 * 需要先启动本地代理。
 *
 * API Key 获取（自动）：
 *   1. 若设置了 OPENAI_API_KEY 且有效，直接使用；
 *   2. 否则自动发起代理浏览器登录流程（POST /auth/huawei/browser/start），
 *      自动打开浏览器让你完成华为云登录，轮询状态后 finalize 提取 auth_key。
 *
 * 场景：
 *   S1 正常多轮（工具对贯穿）——每轮新 response_message_id、prompt_tokens 合理增长
 *   S2 纯工具段热切换（核心回归）——外部 [assistant(tool_call), tool] 无 user 尾部，
 *      验证 proxy 补发工具段而非重复首条 user（以 prompt_tokens 增幅判断）
 *   S3 中段损伤重置后恢复
 *   S4 duplicate/stale 自动重置后可继续（修正历史脚本「期望非 200」的过时断言）
 *   S5 冷启动新 chat_id 首轮
 *
 * 运行：
 *   npm run verify:tool-continuation
 */

import { execFile } from "node:child_process";
import { randomBytes } from "crypto";

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

interface CodeArtsMetadata {
  chat_id?: string;
  response_message_id?: string;
  request_message_id?: string;
}

interface CompletionResponse {
  choices?: Array<{ message?: { role?: string; content?: string } }>;
  codearts?: CodeArtsMetadata;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

const baseUrl = (process.env.OPENAI_BASE_URL ?? "http://localhost:1455").replace(/\/$/, "");
const model = process.env.CODEARTS_TEST_MODEL ?? "GLM-5.2";
const stream = process.env.CODEARTS_TEST_STREAM === "true";

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
// OpenAI 兼容请求
// ---------------------------------------------------------------------------

async function post(
  apiKey: string,
  chatId: string,
  messages: Message[],
): Promise<{ response: CompletionResponse; status: number; raw: string }> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify({ model, stream, messages, codearts: { chat_id: chatId } }),
  });
  const raw = await res.text();
  if (!res.ok) return { status: res.status, raw, response: { error: { message: raw.slice(0, 500) } } };
  if (!stream) return { status: res.status, raw, response: JSON.parse(raw) as CompletionResponse };
  return { status: res.status, raw, response: parseStream(raw) };
}

function parseStream(raw: string): CompletionResponse {
  let content = "";
  let metadata: CodeArtsMetadata | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const chunk = JSON.parse(line.slice(6)) as {
        codearts?: CodeArtsMetadata;
        choices?: Array<{ delta?: { content?: string } }>;
      };
      metadata ??= chunk.codearts;
      content += chunk.choices?.[0]?.delta?.content ?? "";
    } catch {
      // 忽略畸形行
    }
  }
  return { codearts: metadata, choices: [{ message: { role: "assistant", content } }] };
}

function assertOk(
  label: string,
  r: { response: CompletionResponse; status: number },
): CodeArtsMetadata | undefined {
  const meta = r.response.codearts;
  if (r.status !== 200 || !meta?.response_message_id) {
    throw new Error(`${label} 失败: HTTP ${r.status}, ${r.response.error?.message ?? "缺少 response_message_id"}`);
  }
  console.log(JSON.stringify({
    scenario: label,
    status: r.status,
    response_message_id: "已返回",
    prompt_tokens: r.response.usage?.prompt_tokens ?? null,
    content_preview: String(r.response.choices?.[0]?.message?.content ?? "").slice(0, 100),
  }));
  return meta;
}

function checkNewId(label: string, meta: CodeArtsMetadata | undefined, prev: string | undefined): void {
  if (!meta || !prev) return;
  if (meta.response_message_id === prev) {
    throw new Error(`${label}: 未产生新的 response_message_id（链未推进）`);
  }
}

// ---------------------------------------------------------------------------
// 主流程（S1-S5）
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const apiKey = await obtainApiKey();
  const system: Message = { role: "system", content: "你正在执行连续性验证。请严格按用户请求中的标记回复，不要编造历史内容。" };

  // ── S1：正常多轮 ───────────────────────────────────────────────────────
  const c1 = newChatId();
  const u1: Message = { role: "user", content: "第一轮，回复 VERIFY-1。" };
  const r1 = await post(apiKey, c1, [system, u1]);
  const m1 = assertOk("S1-normal-first-turn", r1);
  const a1: Message = { role: "assistant", content: String(r1.response.choices?.[0]?.message?.content ?? "VERIFY-1") };
  const u2: Message = { role: "user", content: "第二轮，回复 VERIFY-2。" };
  const r2 = await post(apiKey, c1, [system, u1, a1, u2]);
  const m2 = assertOk("S1-normal-continuation", r2);
  checkNewId("S1-2", m2, m1?.response_message_id);
  const prompt1 = r1.response.usage?.prompt_tokens ?? 0;
  const prompt2 = r2.response.usage?.prompt_tokens ?? 0;
  if (prompt2 < prompt1) {
    throw new Error(`S1: 第二轮 prompt_tokens 异常回退（${prompt1} → ${prompt2}）`);
  }

  // ── S2：纯工具段热切换（核心回归，无 user 尾部）────────────────────────
  const c2 = newChatId();
  const s2u1: Message = { role: "user", content: "启动会话，回复 SPIKE-BASE。" };
  const s2r1 = await post(apiKey, c2, [system, s2u1]);
  assertOk("S2-base-turn", s2r1);
  const s2a1: Message = { role: "assistant", content: String(s2r1.response.choices?.[0]?.message?.content ?? "SPIKE-BASE") };
  // 外部 provider 工具对（非内置工具），无 user 尾部 → 应触发纯工具段 tail 补发
  const extAsst: Message = {
    role: "assistant",
    content: "外部调用 find_path 查找文件",
    tool_calls: [{ id: "tc-1", type: "function", function: { name: "find_path", arguments: "{\"path\":\".\"}" } }],
  };
  const extTool: Message = {
    role: "tool",
    content: "找到文件 x.txt",
    tool_call_id: "tc-1",
    name: "find_path",
  };
  const s2r2 = await post(apiKey, c2, [system, s2u1, s2a1, extAsst, extTool]);
  const pBase = s2r1.response.usage?.prompt_tokens ?? 0;
  const pSwitch = s2r2.response.usage?.prompt_tokens ?? 0;
  assertOk("S2-tool-segment-tail", s2r2);
  const delta = pSwitch - pBase;
  console.log(JSON.stringify({
    scenario: "S2-prompt-delta",
    delta,
    warn: "若 delta 异常偏大，请检查 proxy 日志 divergence/suffixStart/foldedChars",
  }));

  // ── S3：中段损伤重置后恢复 ─────────────────────────────────────────────
  const c3 = newChatId();
  const m3u1: Message = { role: "user", content: "原始问题：回复 SPIKE-3-OK。" };
  const m3r1 = await post(apiKey, c3, [system, m3u1]);
  assertOk("S3-first", m3r1);
  const m3a1: Message = { role: "assistant", content: String(m3r1.response.choices?.[0]?.message?.content ?? "SPIKE-3-OK") };
  const editedU1: Message = { role: "user", content: "编辑后的问题：回复 SPIKE-3-EDITED。" };
  const m3r2 = await post(apiKey, c3, [system, editedU1, m3a1, { role: "user", content: "继续，回复 SPIKE-3-OK2。" }]);
  assertOk("S3-middle-damage-reset", m3r2);
  const res3a = String(m3r2.response.choices?.[0]?.message?.content ?? "");
  const m3r3 = await post(apiKey, c3, [system, editedU1, m3a1, { role: "user", content: "继续，回复 SPIKE-3-OK2。" }, { role: "assistant", content: res3a }, { role: "user", content: "下一轮，回复 SPIKE-3-OK3。" }]);
  assertOk("S3-recover-normal", m3r3);

  // ── S4：duplicate/stale 自动重置后可继续（修正历史「期望拒绝」断言）────
  const c4 = newChatId();
  const m4u1: Message = { role: "user", content: "首轮：回复 SPIKE-4-OK。" };
  const m4r1 = await post(apiKey, c4, [system, m4u1]);
  assertOk("S4-first", m4r1);
  const m4a1: Message = { role: "assistant", content: String(m4r1.response.choices?.[0]?.message?.content ?? "SPIKE-4-OK") };
  const sameHistory = [system, m4u1, m4a1, { role: "user", content: "重复请求：回复 SPIKE-4-DUP。" }] as Message[];
  const m4r2 = await post(apiKey, c4, sameHistory);
  if (m4r2.status !== 200) {
    throw new Error(`S4: duplicate/stale 应自动重置而非拒绝（HTTP ${m4r2.status}）`);
  }
  assertOk("S4-duplicate-auto-repair", m4r2);
  const m4a2: Message = { role: "assistant", content: String(m4r2.response.choices?.[0]?.message?.content ?? "SPIKE-4-DUP") };
  const m4r3 = await post(apiKey, c4, [...sameHistory, m4a2, { role: "user", content: "重置后继续：回复 SPIKE-4-CONT。" }]);
  assertOk("S4-continue-after-repair", m4r3);

  // ── S5：冷启动新 chat_id ───────────────────────────────────────────────
  const c5 = newChatId();
  const s5r1 = await post(apiKey, c5, [system, { role: "user", content: "冷启动：回复 SPIKE-5-OK。" }]);
  assertOk("S5-cold-start", s5r1);

  console.log(JSON.stringify({
    ok: true,
    note: "请同时查看 proxy 日志中的 divergence、suffixStart、fullContextInjected、foldedChars 字段以核对预期。",
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
