/**
 * 实验2：验证大折叠文本的重置效果 + 接近上游限制的行为
 *
 * 实验目的：
 *   1. 验证大折叠文本（如 100K chars）重置后 prompt_tokens ≈ 折叠文本大小
 *   2. 验证接近 196608 限制时上游报错
 *   3. 验证报错后 forceResync 重置能恢复
 *
 * 用法：pnpm exec ts-node scripts/experiment-large-fold-reset.ts
 */

import { randomUUID } from "crypto";
import https from "https";

import { config } from "../src/config";
import { loadPersistedAuthStore } from "../src/store/user-store";
import { listSessionKeyIds, getSession, refreshStoredSession } from "../src/auth/huawei/session-store";
import { getCredentials } from "../src/auth/huawei/credentials";
import { buildChatHeaders } from "../src/upstream/huawei/chat-request";
import { getProviderAccount } from "../src/auth/store";

const args = process.argv.slice(2);
const modelOverride = (() => {
  const i = args.indexOf("--model");
  return i >= 0 ? args[i + 1] : undefined;
})();
const verbose = args.includes("--verbose");

const MODEL = modelOverride ?? "GLM-5.2";
const UPSTREAM_LIMIT = 196608;

interface SSEResult {
  status: number;
  promptTokens: number;
  completionTokens: number;
  responseMessageId?: string;
  errorCode?: string;
  errorMsg?: string;
  content: string;
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
        let buf = "";
        let promptTokens = 0;
        let completionTokens = 0;
        let responseMessageId: string | undefined;
        let errorCode: string | undefined;
        let errorMsg: string | undefined;
        let content = "";

        const parseLine = (line: string) => {
          if (!line.trim()) return;
          if (verbose) console.log(`  | ${line.slice(0, 200)}${line.length > 200 ? "..." : ""}`);
          const dataMatch = line.match(/^data:\s*(.+)$/);
          if (!dataMatch) return;
          try {
            const evt = JSON.parse(dataMatch[1]);
            if (evt.prompt_tokens) promptTokens = evt.prompt_tokens;
            if (evt.completion_tokens) completionTokens = evt.completion_tokens;
            if (evt.response_message_id) responseMessageId = evt.response_message_id;
            if (evt.error_code && evt.error_code !== "0" && evt.error_code !== "ChatAgent.00000000") {
              errorCode = evt.error_code;
              errorMsg = evt.error_msg;
            }
            if (evt.delta?.content) content += evt.delta.content;
          } catch {
            // 非 JSON
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
            errorCode,
            errorMsg,
            content,
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

// 构造大文本：重复填充使折叠文本达到指定字符数
function buildLargeFoldedContent(chars: number): string {
  const header = "[user]\n以下是之前的对话历史摘要，请基于此继续对话：\n\n";
  const filler = "这是一段历史对话内容，包含用户问题和助手回答。".repeat(Math.ceil((chars - header.length) / 30));
  return (header + filler).slice(0, chars);
}

(async () => {
  try {
    loadPersistedAuthStore();
    const keyIds = listSessionKeyIds();
    if (keyIds.length === 0) {
      console.error("✗ 没有已存储的 Huawei session。");
      process.exit(1);
    }

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
      const refreshed = await refreshStoredSession(keyId);
      if (refreshed) {
        session = refreshed;
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
    console.log(`✓ 凭证加载成功, model: ${MODEL}, upstream limit: ${UPSTREAM_LIMIT}`);

    const chatUrl = `${config.huaweiChatHost}/v1/chat/chat`;
    const chatId = randomUUID().replace(/-/g, "").slice(0, 32);
    console.log(`\n========== 实验2 开始 ==========`);
    console.log(`chat_id: ${chatId}`);

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
      console.log(`  parent: "${parentMessageId.slice(0, 16)}${parentMessageId ? "..." : ""}"`);
      console.log(`  content 长度: ${messages[0]?.content.length ?? 0} chars`);

      const result = await postAndStream(chatUrl, headers, bodyJson);
      console.log(`  HTTP: ${result.status}, prompt_tokens: ${result.promptTokens}, completion: ${result.completionTokens}`);
      if (result.responseMessageId) console.log(`  resp_msg_id: ${result.responseMessageId}`);
      if (result.errorCode) console.log(`  ⚠️ error: ${result.errorCode} - ${result.errorMsg ?? ""}`);
      if (result.content) console.log(`  content: ${result.content.slice(0, 80)}${result.content.length > 80 ? "..." : ""}`);
      return result;
    };

    // 步骤1: 中等折叠文本（50K chars ≈ 17K tokens）重置
    console.log(`\n=== 步骤1: 中等折叠文本(50K chars)重置 ===`);
    const fold50k = buildLargeFoldedContent(50000);
    const r1 = await sendRound(
      "轮1(50K折叠)",
      [{ type: "text", content: fold50k }],
      "",
      "parent 空, 50K chars 折叠文本",
    );

    // 步骤2: 续传
    const r2 = await sendRound(
      "轮2(续传)",
      [{ type: "text", content: "继续" }],
      r1.responseMessageId ?? "",
      "parent=轮1, 短增量",
    );

    // 步骤3: 大折叠文本（200K chars ≈ 70K tokens）重置
    console.log(`\n=== 步骤3: 大折叠文本(200K chars)重置 ===`);
    const fold200k = buildLargeFoldedContent(200000);
    const r3 = await sendRound(
      "轮3(200K折叠)",
      [{ type: "text", content: fold200k }],
      "",
      "parent 空(重置), 200K chars 折叠文本",
    );

    // 步骤4: 续传
    const r4 = await sendRound(
      "轮4(续传)",
      [{ type: "text", content: "继续" }],
      r3.responseMessageId ?? "",
      "parent=轮3, 短增量",
    );

    // 步骤5: 超大折叠文本（600K chars ≈ 210K tokens，应超 196608 限制）
    console.log(`\n=== 步骤5: 超大折叠文本(600K chars)测试上游限制 ===`);
    const fold600k = buildLargeFoldedContent(600000);
    const r5 = await sendRound(
      "轮5(600K折叠)",
      [{ type: "text", content: fold600k }],
      "",
      "parent 空, 600K chars (应超限)",
    );

    // 步骤6: 如果轮5报错，用 forceResync（200K 折叠）恢复
    if (r5.errorCode || r5.promptTokens === 0) {
      console.log(`\n=== 步骤6: 报错后 forceResync 恢复 ===`);
      const r6 = await sendRound(
        "轮6(恢复)",
        [{ type: "text", content: fold200k }],
        "",
        "parent 空, 200K 折叠文本恢复",
      );
      console.log(`\n恢复结果: prompt_tokens=${r6.promptTokens}, error=${r6.errorCode ?? "无"}`);
    }

    // ── 分析 ──
    console.log(`\n========== 实验2 结论 ==========`);
    console.log(`\n各轮 prompt_tokens:`);
    console.log(`  轮1(50K折叠):    ${r1.promptTokens} (折叠 50K chars)`);
    console.log(`  轮2(续传):       ${r2.promptTokens}`);
    console.log(`  轮3(200K折叠):   ${r3.promptTokens} (折叠 200K chars)`);
    console.log(`  轮4(续传):       ${r4.promptTokens}`);
    console.log(`  轮5(600K折叠):   ${r5.promptTokens} (折叠 600K chars, ${r5.errorCode ? "报错: " + r5.errorCode : "成功"})`);

    console.log(`\n关键观察:`);
    console.log(`  1. 50K 折叠 → ${r1.promptTokens} tokens (chars/tokens ratio: ${(50000 / r1.promptTokens).toFixed(2)})`);
    console.log(`  2. 200K 折叠 → ${r3.promptTokens} tokens (chars/tokens ratio: ${(200000 / r3.promptTokens).toFixed(2)})`);
    console.log(`  3. 600K 折叠 → ${r5.promptTokens} tokens ${r5.errorCode ? "(触发上游限制)" : "(未触发?)"}`);
    console.log(`  4. 续传增量: 轮2-轮1=${r2.promptTokens - r1.promptTokens}, 轮4-轮3=${r4.promptTokens - r3.promptTokens}`);

    console.log(`\n========== 实验2 结束 ==========\n`);
  } catch (err) {
    console.error(`\n✗ 实验失败:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
})();
