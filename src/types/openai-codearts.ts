/**
 * CodeArts-specific type definitions — not part of the OpenAI API spec.
 */

export interface OpenAICodeArtsRequestOptions {
  /**
   * 代理侧会话键，仅用于链状态与缓存命中追踪；不会发送给上游。
   * 缺失时按 system + 首条 user 内容哈希派生。
   */
  chat_id?: string | null;
  /** 覆盖上游 model_id（默认按请求 model 映射）。 */
  model_id?: string | null;
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
