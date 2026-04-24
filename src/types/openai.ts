/**
 * OpenAI API 兼容类型定义
 * 遵循 OpenAI API 规范: https://platform.openai.com/docs/api-reference
 */

// ==================== 基础类型 ====================

export interface OpenAIError {
  message: string;
  type: string;
  param: string | null;
  code: string | null;
}

// ==================== 模型相关类型 ====================

export interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface OpenAIModelsResponse {
  object: "list";
  data: OpenAIModel[];
}

// ==================== 消息相关类型 ====================

export type OpenAIChatRole =
  | "system"
  | "user"
  | "assistant"
  | "function"
  | "tool";

export interface OpenAIChatMessage {
  role: OpenAIChatRole;
  content: string | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAITool {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

// ==================== Chat Completion 相关类型 ====================

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
}

export interface OpenAICodeArtsRequestOptions {
  /** 会话 ID，调用方维护；缺失时代理自动生成新会话 */
  chat_id?: string | null;
  /** 上一轮响应的 response_message_id，调用方维护；新对话首条消息传 "" 或不传 */
  parent_message_id?: string | null;
  preferred_language?: string | null;
  project_level_prompt?: string | null;
  codebase_search?: boolean | null;
  enable_code_interpreter?: boolean | null;
  workspace_root?: string | null;
  current_working_directory?: string | null;
  os_version?: string | null;
  contexts?: unknown[] | null;
  expert_rules?: unknown[] | null;
  model_id?: string | null;
  tool_results?: CodeArtsToolResult[] | null;
  sub_agent?: OpenAICodeArtsSubAgentOptions | null;
}

export interface OpenAICodeArtsSubAgentOptions {
  type: string;
  prompt?: string | null;
}

export interface CodeArtsToolResult {
  feedback?: string;
  result: string;
  name: string;
  arguments?: Record<string, unknown>;
  status?: string;
  executeStatus?: string;
  toolCallId?: string;
}

export interface OpenAIChatCompletionChoice {
  index: number;
  message: OpenAIChatMessage;
  finish_reason:
    | "stop"
    | "length"
    | "function_call"
    | "tool_calls"
    | "content_filter"
    | null;
}

export interface OpenAIChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  codearts?: OpenAICodeArtsResponseMetadata;
  choices: OpenAIChatCompletionChoice[];
  usage?: OpenAIUsage;
  system_fingerprint?: string;
}

export interface OpenAICodeArtsResponseMetadata {
  chat_id?: string;
  response_message_id?: string;
  request_message_id?: string;
  model_id?: string;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ==================== 流式响应相关类型 ====================

export interface OpenAIChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  codearts?: OpenAICodeArtsResponseMetadata;
  choices: OpenAIChatCompletionChunkChoice[];
  system_fingerprint?: string;
}

export interface OpenAIChatCompletionChunkChoice {
  index: number;
  delta: OpenAIChatCompletionDelta;
  finish_reason:
    | "stop"
    | "length"
    | "function_call"
    | "tool_calls"
    | "content_filter"
    | null;
}

export interface OpenAIChatCompletionDelta {
  role?: OpenAIChatRole;
  content?: string | null;
  reasoning_content?: string | null;
  function_call?: { name?: string; arguments?: string };
  tool_calls?: OpenAIToolCallDelta[];
}

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}
