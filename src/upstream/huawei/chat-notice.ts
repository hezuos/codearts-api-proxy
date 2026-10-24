/**
 * 统一 notice 机制：流式 emitNoticeChunk。
 *
 * 仅用于向客户端发送可见提示（例如上游限流重试）。代理不再用 notice 告知
 * 上下文被压缩——因为已经不存在压缩/折叠路径。
 */
import type { ServerResponse } from "http";
import type { OpenAIChatCompletionChunk } from "../../types/openai";

/**
 * 流式：向 res 写入一个 notice chunk（SSE data line）。
 *
 * @returns 更新后的 sentRole/sentMetadata 状态（调用方用于后续 chunk 判断）
 */
export function emitNoticeChunk(
  res: ServerResponse,
  params: {
    id: string;
    created: number;
    model: string;
    content: string;
    sentRole: boolean;
    sentMetadata: boolean;
    responseMetadata: Record<string, string | undefined>;
  },
): { sentRole: boolean; sentMetadata: boolean } {
  const chunk: OpenAIChatCompletionChunk = {
    id: params.id,
    object: "chat.completion.chunk",
    created: params.created,
    model: params.model,
    ...(params.sentMetadata ? {} : { codearts: { ...params.responseMetadata } }),
    choices: [
      {
        index: 0,
        delta: {
          ...(params.sentRole ? {} : { role: "assistant" as const }),
          content: params.content,
        },
        finish_reason: null,
      },
    ],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  return { sentRole: true, sentMetadata: true };
}
