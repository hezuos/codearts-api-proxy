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

export interface OpenAIResponse<T> {
  data: T;
  error?: OpenAIError;
}

// ==================== 模型相关类型 ====================

export interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  permission?: OpenAIModelPermission[];
  root?: string;
  parent?: string;
}

export interface OpenAIModelPermission {
  id: string;
  object: "model_permission";
  created: number;
  allow_create_engine: boolean;
  allow_sampling: boolean;
  allow_logprobs: boolean;
  allow_search_indices: boolean;
  allow_view: boolean;
  allow_fine_tuning: boolean;
  organization: string;
  group: string | null;
  is_blocking: boolean;
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
  function_call?: OpenAIFunctionCall;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface OpenAIFunctionCall {
  name: string;
  arguments: string;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: OpenAIFunctionCall;
}

export interface OpenAIFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIFunctionDefinition;
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
  functions?: OpenAIFunctionDefinition[] | null;
  function_call?: "none" | "auto" | { name: string } | null;
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
  logprobs?: OpenAILogProbs | null;
}

export interface OpenAILogProbs {
  content: OpenAILogProbsContent[] | null;
}

export interface OpenAILogProbsContent {
  token: string;
  logprob: number;
  bytes: number[] | null;
  top_logprobs: OpenAITopLogProb[];
}

export interface OpenAITopLogProb {
  token: string;
  logprob: number;
  bytes: number[] | null;
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
  logprobs?: OpenAILogProbs | null;
}

export interface OpenAIChatCompletionDelta {
  role?: OpenAIChatRole;
  content?: string | null;
  reasoning_content?: string | null;
  function_call?: OpenAIFunctionCallDelta;
  tool_calls?: OpenAIToolCallDelta[];
}

export interface OpenAIFunctionCallDelta {
  name?: string;
  arguments?: string;
}

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: OpenAIFunctionCallDelta;
}

// ==================== Embeddings 相关类型 ====================

export interface OpenAIEmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
}

export interface OpenAIEmbedding {
  object: "embedding";
  embedding: number[];
  index: number;
}

export interface OpenAIEmbeddingsResponse {
  object: "list";
  data: OpenAIEmbedding[];
  model: string;
  usage: OpenAIUsage;
}

// ==================== 模型映射相关类型 ====================

export interface ModelMapping {
  openaiModelId: string;
  codeartsModelId: string;
  displayName: string;
  contextWindow: number;
  maxTokens: number;
  supportsStream: boolean;
  supportsFunction: boolean;
  supportsVision: boolean;
}

// ==================== 配置相关类型 ====================

export interface ProxyConfig {
  port: number;
  host: string;
  baseUrl: string;
  apiKey?: string;
  timeout: number;
  maxRetries: number;
  retryDelay: number;
  enableCors: boolean;
  corsOrigins: string[];
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
    format: "json" | "simple";
  };
}

export interface AuthConfig {
  type: "session" | "apiKey" | "custom";
  sessionData?: {
    access: string;
    secret: string;
    securitytoken: string;
    expiresAt: string;
  };
  customAuthUrl?: string;
}

// ==================== 请求/响应转换器类型 ====================

export interface OpenAIToCodeArtsConverter {
  (request: OpenAIChatCompletionRequest): CodeArtsChatRequest;
}

export interface CodeArtsToOpenAIConverter {
  (response: CodeArtsChatResponse): OpenAIChatCompletion;
}

// ==================== 内部 CodeArts 类型（部分定义，完整定义在 codearts.ts）====================

export interface CodeArtsChatRequest {
  chat_id: string;
  messages: Array<{
    type: string;
    value: { input: string } | Record<string, unknown>;
  }>;
  client: string;
  task: string;
  task_parameters: Record<string, unknown>;
  batch_task_parameters: unknown[];
  attempt: number;
  user_id: string;
  trigger_mode: string;
  master_body?: string;
  parent_message_id?: string;
  is_delta_response: boolean;
  model_id?: string;
  agent_id?: string;
  file_id?: string;
  mcp_servers?: unknown[];
}

export interface CodeArtsChatResponse {
  id: string;
  model: string;
  type: string;
  chat_id: string;
  response_message_id: string;
  request_message_id: string;
  agent_name: string;
  is_delta_response: boolean;
  is_model_auto_switched: boolean;
  prompt_id: string;
  prompt_tokens: number;
  rag_references: unknown[];
  rag_flywheel: unknown[];
  long_term_memory_info: Record<string, unknown>;
  query_optimize: boolean;
  text: string;
  output: Array<{
    type: string;
    text: string;
    name: string | null;
    id: string | null;
    arguments: Record<string, unknown>;
  }>;
  response_message_id_field?: string;
  error_code: string;
}

// ==================== 工具函数类型 ====================

export type EventType = "completion" | "delta" | "error" | "done";

export interface StreamEvent {
  type: EventType;
  data: OpenAIChatCompletion | OpenAIChatCompletionChunk | OpenAIError;
}

export type StreamCallback = (event: StreamEvent) => void;
