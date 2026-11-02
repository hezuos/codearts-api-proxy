/**
 * 对话标识解析：稳定、账号无关。
 *
 * 来源优先级：
 * 1. 请求体 `codearts.chat_id`——客户端显式覆盖，直接采用；
 * 2. 稳定对话键 `codearts.conversation_id`——通常由路由层从 `X-Conversation-Id`
 *    请求头填充，也允许客户端直接在请求体提供；
 * 3. 首条用户消息内容指纹——不含系统提示词，也不含账号。
 *
 * 三者均不可得时**不绑定任何对话标识**：代理不得以随机值冒充稳定标识
 * （随机标识会让续传链状态与缓存估算永久失配）。
 */

import { createHash } from "crypto";
import type { OpenAIChatCompletionRequest } from "../../types/openai";
import { normalizeMessageContent } from "./chat-translate";

/** 客户端可显式提供稳定对话键的请求头。 */
export const CONVERSATION_ID_HEADER = "x-conversation-id";

/** 对话标识的来源，用于日志与可观测性。 */
export type ConversationIdSource =
  | "body"
  | "stable-key"
  | "fingerprint"
  | "none";

export interface ConversationIdentity {
  /** 账号无关的对话标识；undefined 表示本请求没有可用稳定标识。 */
  conversationId?: string;
  /** 标识来源。 */
  source: ConversationIdSource;
}

/** 派生固定长度的短哈希（前 32 字符十六进制）。 */
function shortHash(domain: string, value: string): string {
  return createHash("sha256")
    .update(`${domain}:${value}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * 按来源链解析对话标识。
 *
 * 解析结果不含 ProviderAccount，也不含系统提示词内容：同一对话在切换账号
 * 或系统提示词漂移后仍得到相同标识。
 */
export function resolveConversationIdentity(
  request: OpenAIChatCompletionRequest,
): ConversationIdentity {
  const explicit = request.codearts?.chat_id?.trim();
  if (explicit) {
    return { conversationId: explicit, source: "body" };
  }

  const stableKey = request.codearts?.conversation_id?.trim();
  if (stableKey) {
    return { conversationId: shortHash("key", stableKey), source: "stable-key" };
  }

  const firstUser = request.messages?.find((m) => m.role === "user");
  if (firstUser) {
    const content = normalizeMessageContent(firstUser.content);
    if (content) {
      return { conversationId: shortHash("fp", content), source: "fingerprint" };
    }
  }

  return { source: "none" };
}

/**
 * 把 HTTP 请求头中的稳定对话键填入请求体的 CodeArts 扩展。
 *
 * 请求体已提供 `conversation_id` 时不覆盖（请求体优先）。
 * `codearts` 结构非法时安全降级：重建为仅含对话键的扩展对象，不抛错。
 *
 * @returns 是否写入了对话键。
 */
export function applyConversationIdHeader(
  request: OpenAIChatCompletionRequest,
  headerValue: string | undefined,
): boolean {
  const headerId = headerValue?.trim();
  if (!headerId) return false;

  const codearts =
    request.codearts && typeof request.codearts === "object"
      ? request.codearts
      : {};
  if (codearts.conversation_id) return false;

  request.codearts = { ...codearts, conversation_id: headerId };
  return true;
}

/**
 * 链状态键：(对话标识, ProviderAccount) 组合。
 *
 * 分隔符用 NUL，避免标识本身含分隔符时产生歧义。
 */
export function buildChainKey(
  conversationId: string,
  providerAccountId: string,
): string {
  return `${conversationId}\u0000${providerAccountId}`;
}
