/**
 * CodeArts-specific type definitions — not part of the OpenAI API spec.
 */

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

export interface OpenAICodeArtsResponseMetadata {
  chat_id?: string;
  response_message_id?: string;
  request_message_id?: string;
  model_id?: string;
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
