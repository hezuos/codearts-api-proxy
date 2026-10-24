/**
 * OpenAI API 兼容类型定义
 * 标准类型来自官方 openai npm 包 (import type)，CodeArts 扩展通过 intersection types 注入。
 */

import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionFunctionTool,
  ChatCompletionRole,
} from "openai/resources/chat/completions/completions";
import type { Model } from "openai/resources/models";
import type { CompletionUsage } from "openai/resources/completions";
import type {
  OpenAICodeArtsRequestOptions,
  OpenAICodeArtsResponseMetadata,
} from "./openai-codearts";

// ==================== 基础类型 ====================

export interface OpenAIError {
  message: string;
  type: string;
  param: string | null;
  code: string | null;
}

// ==================== 模型相关类型 ====================

export type OpenAIModel = Model;

export interface OpenAIModelsResponse {
  object: "list";
  data: OpenAIModel[];
}

// ==================== 消息相关类型 ====================

export type OpenAIChatRole = ChatCompletionRole;

/**
 * 投影接口：包含代理实际访问的所有消息属性。
 * 不使用官方 ChatCompletionMessageParam discriminated union，
 * 因为代理遍历消息数组时需要统一访问跨 role 的属性。
 */
export interface OpenAIChatMessage {
  role: OpenAIChatRole | "developer";
  content: string | null;
  refusal: string | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export type OpenAIToolCall = ChatCompletionMessageFunctionToolCall;

export type OpenAITool = ChatCompletionFunctionTool;

// ==================== Chat Completion 相关类型 ====================

/**
 * 请求类型：基于官方 ChatCompletionCreateParamsNonStreaming，
 * 但用 OpenAIChatMessage[] 替代 ChatCompletionMessageParam[]（投影接口兼容），
 * 并注入 codearts 扩展。
 */
export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number | null;
  top_p?: number | null;
  n?: number | null;
  stream?: boolean | null;
  stop?: string | string[] | null;
  max_tokens?: number | null;
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  logit_bias?: Record<string, number> | null;
  user?: string | null;
  tools?: OpenAITool[] | null;
  tool_choice?:
    | "none"
    | "auto"
    | { type: "function"; function: { name: string } }
    | null;
  codearts?: OpenAICodeArtsRequestOptions | null;
  response_format?: { type: "text" | "json_object" } | null;
  seed?: number | null;
  /** OpenAI 官方协议字段：流式 usage opt-in */
  stream_options?: { include_usage?: boolean | null } | null;
}

export type OpenAIChatCompletion = ChatCompletion & {
  codearts?: OpenAICodeArtsResponseMetadata;
  /** 覆盖 usage 字段类型，让非流式响应支持缓存字段（与 OpenAIChatCompletionChunk 对齐） */
  usage?: OpenAIUsage;
};

/**
 * OpenAI usage 扩展 DeepSeek 风格缓存计费字段。
 *
 * - `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`：估算的缓存命中/未命中 token 数
 * - `cache_estimated: true`：标记为估算值（华为云上游不返回真实缓存命中数）
 */
export type OpenAIUsage = Omit<CompletionUsage, "prompt_tokens_details"> & {
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  cache_estimated?: boolean;
  prompt_tokens_details?: {
    cached_tokens?: number;
    text_tokens?: number;
    audio_tokens?: number;
    cache_write_tokens?: number;
  };
};

// ==================== 流式响应相关类型 ====================

export type OpenAIChatCompletionChunk = ChatCompletionChunk & {
  codearts?: OpenAICodeArtsResponseMetadata;
  /** 覆盖 usage 字段类型，让流式 chunk 支持缓存字段 */
  usage?: OpenAIUsage | null;
};

/**
 * 流式 delta：基于官方 Delta，增加 reasoning_content 扩展。
 */
export interface OpenAIChatCompletionDelta {
  role?: OpenAIChatRole | "developer";
  content?: string | null;
  reasoning_content?: string | null;
  function_call?: { name?: string; arguments?: string };
  tool_calls?: OpenAIToolCallDelta[];
}

export type OpenAIToolCallDelta = ChatCompletionChunk.Choice.Delta.ToolCall;

// ==================== CodeArts 扩展类型重新导出 ====================

export type {
  OpenAICodeArtsRequestOptions,
  OpenAICodeArtsSubAgentOptions,
  OpenAICodeArtsResponseMetadata,
} from "./openai-codearts";
