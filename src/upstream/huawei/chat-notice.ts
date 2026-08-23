/**
 * 统一 notice 机制：流式 emitNoticeChunk + 非流式 buildNoticeMetadata。
 *
 * 所有原本静默的处理路径（proactive reset、folding、tail-divergence resync、
 * ChatAgent.00001216 recovery）通过此模块向客户端发送可见提示。
 */
import type { ServerResponse } from "http";
import type { OpenAIChatCompletionChunk } from "../../types/openai";
import type { OpenAICodeArtsResponseMetadata } from "../../types/openai-codearts";

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
    extraMetadata?: Partial<OpenAICodeArtsResponseMetadata>;
  },
): { sentRole: boolean; sentMetadata: boolean } {
  const metadata: OpenAICodeArtsResponseMetadata | undefined = params.sentMetadata
    ? undefined
    : { ...params.responseMetadata, ...params.extraMetadata };

  const chunk: OpenAIChatCompletionChunk = {
    id: params.id,
    object: "chat.completion.chunk",
    created: params.created,
    model: params.model,
    ...(metadata ? { codearts: metadata } : {}),
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

/**
 * 非流式：构建 notice metadata，合并到响应的 codearts 字段。
 */
export function buildNoticeMetadata(
  fields: Partial<OpenAICodeArtsResponseMetadata>,
): Partial<OpenAICodeArtsResponseMetadata> {
  const result: Partial<OpenAICodeArtsResponseMetadata> = {};
  if (fields.context_reset) result.context_reset = fields.context_reset;
  if (fields.error_recovery) result.error_recovery = fields.error_recovery;
  return result;
}
