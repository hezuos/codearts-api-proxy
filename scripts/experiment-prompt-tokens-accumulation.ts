/**
 * 实验：验证上游 prompt_tokens 累积语义 + forceResync 重置效果
 *
 * 实验目的：
 *   1. 验证多轮热链续传时 prompt_tokens 递增（累积历史总长，非本轮增量）
 *   2. 验证 forceResync（parent 空 + 全量折叠）后 prompt_tokens 回落（历史重置）
 *   3. 验证重置后能继续续传（新链建立）
 *
 * 实验步骤：
 *   轮1: 新 chat_id, parent 空, 短消息 → 记录 prompt_tokens_1, resp_msg_id_1
 *   轮2: 同 chat_id, parent=resp_msg_id_1, 短增量 → prompt_tokens_2 (应 > 1)
 *   轮3: 同 chat_id, parent=resp_msg_id_2, 短增量 → prompt_tokens_3 (应 > 2)
 *   轮4(重置): 同 chat_id, parent 空, 全量折叠文本 → prompt_tokens_4 (应 ≈ 折叠大小, 远 < 3)
 *   轮5(重置后续传): 同 chat_id, parent=resp_msg_id_4, 短增量 → prompt_tokens_5 (应 > 4, < 196608)
 *
 * 用法：pnpm exec ts-node scripts/experiment-prompt-tokens-accumulation.ts
 *      pnpm exec ts-node scripts/experiment-prompt-tokens-accumulation.ts --model GLM-5.2
 *
 * 该脚本 gitignore，不入库。依赖项目已存储的 Huawei session。
 */

import { randomUUID } from "crypto";
import https from "https";

import { config } from "../src/config";
import { loadPersistedAuthStore } from "../src/store/user-store";
import { listSessionKeyIds, getSession, refreshStoredSession } from "../src/auth/huawei/session-store";
import { getCredentials } from "../src/auth/huawei/credentials";
import { buildChatHeaders } from "../src/upstream/huawei/chat-request";
import { getProviderAccount } from "../src/auth/store";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const modelOverride = (() => {
  const i = args.indexOf("--model");
  return i >= 0 ? args[i + 1] : undefined;
})();
const verbose = args.includes("--verbose");

const MODEL = modelOverride ?? "GLM-5.2";
const UPSTREAM_LIMIT = 196608; // 上游硬限制

// ---------------------------------------------------------------------------
// SSE 解析：提取 prompt_tokens / completion_tokens / response_message_id / error
// ---------------------------------------------------------------------------
interface SSEResult {
  status: number;
  promptTokens: number;
  completionTokens: number;
  responseMessageId?: string;
  chatId?: string;
  errorCode?: string;
  errorMsg?: string;
  content: string;
  chunks: string[];
}

function postAndStream(
  url: string,
  hdrs: Record<string, string>,
  payload: string,
): Promise<SSEResult> {
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
        res.setEncoding("utf8");
        const chunks: string[] = [];
        let buf = "";
        let promptTokens = 0;
        let completionTokens = 0;
        let responseMessageId: string | undefined;
        let chatId: string | undefined;
        let errorCode: string | undefined;
        let errorMsg: string | undefined;
        let content = "";

        const parseLine = (line: string) => {
          if (!line.trim()) return;
          chunks.push(line);
          if (verbose) console.log(`  | ${line.slice(0, 200)}${line.length > 200 ? "..." : ""}`);

          // SSE data 行解析
          const dataMatch = line.match(/^data:\s*(.+)$/);
          if (!dataMatch) return;
          try {
            const evt = JSON.parse(dataMatch[1]);
            if (evt.prompt_tokens) promptTokens = evt.prompt_tokens;
            if (evt.completion_tokens) completionTokens = evt.completion_tokens;
            if (evt.response_message_id) responseMessageId = evt.response_message_id;
            if (evt.chat_id) chatId = evt.chat_id;
            if (evt.error_code && evt.error_code !== "0" && evt.error_code !== "ChatAgent.00000000") {
              errorCode = evt.error_code;
              errorMsg = evt.error_msg;
            }
            if (evt.delta?.content) content += evt.delta.content;
          } catch {
            // 非 JSON 行，跳过
          }
        };

        res.on("data", (chunk: string) => {
          buf += chunk;
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) parseLine(line);
        });
        res.on("end", () => {
          if (buf.trim()) parseLine(buf);
          resolve({
            status: res.statusCode ?? 0,
            promptTokens,
            completionTokens,
            responseMessageId,
            chatId,
            errorCode,
            errorMsg,
            content,
            chunks,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(500_000, () => {
      req.destroy();
      reject(new Error("Request timeout (500s)"));
    });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 请求体构造
// ---------------------------------------------------------------------------
function buildBody(
  chatId: string,
  messages: { type: string; content: string }[],
  parentMessageId: string,
  userId: string,
): Record<string, unknown> {
  return {
    chat_id: chatId,
    messages,
    client: "IDE",
    task: "plan-execute",
    task_parameters: {
      codebase_search: false,
      preferred_language: "zh-cn",
      enable_code_interpreter: false,
      projectLevelPrompt: "",
      isSubAgent: false,
      tools: [],
      environmentDetails: {
        osVersion: "win32",
        currentDate: new Date().toISOString().replace("Z", ""),
        currentWorkingDirectory: "D:\\projects\\experiment",
      },
      routerVersion: "v2",
      isNewClient: true,
      features: { support_end_tag: true },
      ide: "CodeArts Agent",
      contexts: [],
      expert_rules: [],
    },
    batch_task_parameters: [],
    attempt: 1,
    user_id: userId,
    agent_id: "CodeAgent",
    parent_message_id: parentMessageId,
    is_delta_response: true,
    model_id: MODEL,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
(async () => {
  try {
    // ── 1. 加载 session ──────────────────────────────────────────────────
    loadPersistedAuthStore();
    const keyIds = listSessionKeyIds();
    if (keyIds.length === 0) {
      console.error("✗ 没有已存储的 Huawei session。请先通过 OAuth 登录或配置 AK/SK。");
      process.exit(1);
    }
    console.log(`找到 ${keyIds.length} 个 session keyId: ${keyIds.join(", ")}`);

    const keyId = keyIds[0];
    let session = getSession(keyId);
    if (!session) {
      console.error(`✗ session ${keyId} 不存在`);
      process.exit(1);
    }

    const now = Date.now();
    const expiresAt = session.expiresAt ? new Date(session.expiresAt).getTime() : Infinity;
    const isExpired = expiresAt - now < 5 * 60_000;
    if (isExpired || !session.accessKey || !session.secretKeyCiphertext) {
      console.log(`session 过期或缺少 AK/SK，尝试刷新...`);
      const refreshed = await refreshStoredSession(keyId);
      if (refreshed) {
        session = refreshed;
        console.log(`✓ session 刷新成功`);
      } else {
        console.error(`✗ session 刷新失败`);
        process.exit(1);
      }
    }

    const credentials = getCredentials(session);
    const providerAccount = getProviderAccount(session.providerAccountId);
    const userId =
      providerAccount?.providerUserName?.trim() ||
      providerAccount?.providerUserId?.trim() ||
      session.providerAccountId;
    console.log(`✓ 凭证加载成功: AK=${credentials.accessKey.slice(0, 8)}...`);
    console.log(`✓ model: ${MODEL}, upstream limit: ${UPSTREAM_LIMIT}`);

    const chatUrl = `${config.huaweiChatHost}/v1/chat/chat`;

    // ── 2. 实验轮次 ──────────────────────────────────────────────────────
    // 用固定 chat_id 便于追踪（实际 proxy 用 SHA-256 派生，这里随机即可）
    const chatId = randomUUID().replace(/-/g, "").slice(0, 32);
    console.log(`\n========== 实验开始 ==========`);
    console.log(`chat_id: ${chatId}`);

    const results: { round: string; promptTokens: number; completionTokens: number; respMsgId?: string; errorCode?: string }[] = [];

    const sendRound = async (
      round: string,
      messages: { type: string; content: string }[],
      parentMessageId: string,
      desc: string,
    ): Promise<SSEResult> => {
      const body = buildBody(chatId, messages, parentMessageId, userId);
      const bodyJson = JSON.stringify(body);
      const traceId = randomUUID().replace(/-/g, "").slice(0, 16);
      const headers = buildChatHeaders(chatUrl, bodyJson, credentials, traceId);

      console.log(`\n--- ${round}: ${desc} ---`);
      console.log(`  parent_message_id: "${parentMessageId.slice(0, 16)}${parentMessageId ? "..." : ""}"`);
      console.log(`  messages[0].content 长度: ${messages[0]?.content.length ?? 0} chars`);

      const result = await postAndStream(chatUrl, headers, bodyJson);
      console.log(`  HTTP 状态: ${result.status}`);
      console.log(`  prompt_tokens: ${result.promptTokens}`);
      console.log(`  completion_tokens: ${result.completionTokens}`);
      if (result.responseMessageId) console.log(`  response_message_id: ${result.responseMessageId}`);
      if (result.errorCode) console.log(`  ⚠️ error: ${result.errorCode} - ${result.errorMsg ?? ""}`);
      if (result.content) console.log(`  content 预览: ${result.content.slice(0, 100)}${result.content.length > 100 ? "..." : ""}`);

      results.push({
        round,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        respMsgId: result.responseMessageId,
        errorCode: result.errorCode,
      });
      return result;
    };

    // 轮1: 新链，parent 空，短消息
    const r1 = await sendRound(
      "轮1(冷启动)",
      [{ type: "text", content: "你好，请用一句话介绍你自己。" }],
      "",
      "新 chat_id, parent 空, 短消息",
    );

    // 轮2: 续传，parent=r1.resp, 短增量
    const r2 = await sendRound(
      "轮2(续传)",
      [{ type: "text", content: "什么是 1+1？" }],
      r1.responseMessageId ?? "",
      "同 chat_id, parent=轮1.resp, 短增量",
    );

    // 轮3: 续传，parent=r2.resp, 短增量
    const r3 = await sendRound(
      "轮3(续传)",
      [{ type: "text", content: "什么是 2+2？" }],
      r2.responseMessageId ?? "",
      "同 chat_id, parent=轮2.resp, 短增量",
    );

    // 轮4(重置): parent 空, 全量折叠文本（模拟 forceResync）
    // 折叠文本：把前3轮对话折叠成单条文本
    const foldedContent = [
      "[user #1]",
      "你好，请用一句话介绍你自己。",
      "",
      "[assistant]",
      r1.content || "(无内容)",
      "",
      "[user #2]",
      "什么是 1+1？",
      "",
      "[assistant]",
      r2.content || "(无内容)",
      "",
      "[user #3]",
      "什么是 2+2？",
      "",
      "[continuation] 请继续对话。",
    ].join("\n");
    const r4 = await sendRound(
      "轮4(重置)",
      [{ type: "text", content: foldedContent }],
      "", // parent 空 = forceResync
      "同 chat_id, parent 空(重置), 全量折叠文本",
    );

    // 轮5(重置后续传): parent=r4.resp, 短增量
    const r5 = await sendRound(
      "轮5(重置后续传)",
      [{ type: "text", content: "什么是 3+3？" }],
      r4.responseMessageId ?? "",
      "同 chat_id, parent=轮4.resp, 短增量",
    );

    // ── 3. 分析结论 ──────────────────────────────────────────────────────
    console.log(`\n========== 实验结论 ==========`);
    console.log(`\n各轮 prompt_tokens 汇总:`);
    console.log(`  轮1(冷启动):     ${r1.promptTokens}`);
    console.log(`  轮2(续传):       ${r2.promptTokens}`);
    console.log(`  轮3(续传):       ${r3.promptTokens}`);
    console.log(`  轮4(重置):       ${r4.promptTokens}`);
    console.log(`  轮5(重置后续传): ${r5.promptTokens}`);

    console.log(`\n假设验证:`);

    // 假设1: prompt_tokens 累积（轮2 > 轮1, 轮3 > 轮2）
    const acc1 = r2.promptTokens > r1.promptTokens;
    const acc2 = r3.promptTokens > r2.promptTokens;
    console.log(`  假设1(prompt_tokens 累积):`);
    console.log(`    轮2 > 轮1? ${acc1 ? "✅" : "❌"} (${r2.promptTokens} vs ${r1.promptTokens})`);
    console.log(`    轮3 > 轮2? ${acc2 ? "✅" : "❌"} (${r3.promptTokens} vs ${r2.promptTokens})`);
    console.log(`    结论: ${acc1 && acc2 ? "prompt_tokens 是累积历史总长" : "prompt_tokens 可能不是累积值"}`);

    // 假设2: forceResync 重置（轮4 << 轮3, 轮4 ≈ 折叠文本大小）
    const reset = r4.promptTokens < r3.promptTokens * 0.8;
    console.log(`  假设2(forceResync 重置):`);
    console.log(`    轮4 < 轮3*0.8? ${reset ? "✅" : "❌"} (${r4.promptTokens} vs ${r3.promptTokens})`);
    console.log(`    轮4 vs 折叠文本 ${foldedContent.length} chars: ${r4.promptTokens} tokens`);
    console.log(`    结论: ${reset ? "parent 空时上游历史重置" : "重置效果不明显"}`);

    // 假设3: 重置后能续传（轮5 > 轮4, 轮5 < 196608）
    const cont = r5.promptTokens > r4.promptTokens && r5.promptTokens < UPSTREAM_LIMIT;
    console.log(`  假设3(重置后能续传):`);
    console.log(`    轮5 > 轮4 且 < ${UPSTREAM_LIMIT}? ${cont ? "✅" : "❌"} (${r5.promptTokens})`);
    console.log(`    结论: ${cont ? "重置后新链建立，可继续续传" : "重置后续传异常"}`);

    // 错误检查
    const errors = results.filter((r) => r.errorCode);
    if (errors.length > 0) {
      console.log(`\n⚠️ 有错误轮次:`);
      for (const e of errors) {
        console.log(`  ${e.round}: ${e.errorCode}`);
      }
    }

    console.log(`\n========== 实验结束 ==========\n`);
  } catch (err) {
    console.error(`\n✗ 实验失败:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
})();
