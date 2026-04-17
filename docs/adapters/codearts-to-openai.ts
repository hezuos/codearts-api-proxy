/**
 * CodeArts 到 OpenAI 响应转换器
 * 基于源项目分析：D:/Program Files/CodeArts Agent
 * 参考：docs/codearts-agent-auth-and-requuest-mechanism.md
 * 
 * 源项目响应结构来自 vscode-codebot/out/extension.js 中的 SSE 处理逻辑
 */

// ==================== 类型定义 ====================

interface CodeArtsResponse {
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
  custom_extra_info?: Record<string, unknown>;
  related_question_answer?: unknown[];
  compress_message?: string;
  error_code: string;
  error_msg?: string;
}

interface CodeArtsStreamChunk {
  id: string;
  text?: string;
  output?: Array<{
    type: string;
    text: string;
    name: string | null;
    id: string | null;
    arguments: Record<string, unknown>;
  }>;
  response_message_id?: string;
  is_delta_response?: boolean;
  is_model_auto_switched?: boolean;
  model_name?: string;
  compress_message?: string;
  rag_references?: unknown[];
  rag_flywheel?: unknown[];
  custom_extra_info?: Record<string, unknown>;
  error_code?: string;
}

interface OpenAIChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string;
    function_call?: { name: string; arguments: string };
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  };
  finish_reason: 'stop' | 'length' | 'function_call' | 'tool_calls' | 'content_filter' | null;
}

interface OpenAICompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  system_fingerprint?: string;
}

interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      function_call?: { name?: string; arguments?: string };
      tool_calls?: Array<{ index: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason: 'stop' | 'length' | 'function_call' | 'tool_calls' | 'content_filter' | null;
  }>;
  system_fingerprint?: string;
}

// ==================== 响应转换函数 ====================

/**
 * 将 CodeArts 完整响应转换为 OpenAI 格式
 * 基于源项目 vscode-codebot/out/extension.js 中的响应处理逻辑
 */
export function codeArtsToOpenAI(
  codeartsResponse: CodeArtsResponse,
  model: string = 'gpt-3.5-turbo'
): OpenAICompletionResponse {
  const { id, text, output, response_message_id, prompt_tokens, error_code } = codeartsResponse;

  // 提取文本内容
  let content = text || '';
  if (output && output.length > 0) {
    // 从 output 数组中提取文本
    content = output.map((o) => o.text).join('');
  }

  // 构建 OpenAI 格式响应
  return {
    id: id || response_message_id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content,
        },
        finish_reason: error_code === '0' || !error_code ? 'stop' : null,
      },
    ],
    usage: {
      prompt_tokens: prompt_tokens || 0,
      completion_tokens: estimateTokens(content),
      total_tokens: (prompt_tokens || 0) + estimateTokens(content),
    },
  };
}

/**
 * 将 CodeArts 流式 chunk 转换为 OpenAI 流式格式
 * 基于源项目的 SSE 处理逻辑
 */
export function codeArtsChunkToOpenAI(
  chunk: CodeArtsStreamChunk,
  model: string = 'gpt-3.5-turbo',
  isFirstChunk: boolean = false
): OpenAIStreamChunk {
  const { id, text, output, response_message_id } = chunk;

  // 提取增量文本
  let deltaContent = text || '';
  if (output && output.length > 0) {
    deltaContent = output.map((o) => o.text).join('');
  }

  // 构建 delta 对象
  const delta: OpenAIStreamChunk['choices'][0]['delta'] = {};

  // 第一个 chunk 需要包含 role
  if (isFirstChunk) {
    delta.role = 'assistant';
  }

  // 添加内容
  if (deltaContent) {
    delta.content = deltaContent;
  }

  return {
    id: id || response_message_id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        delta: delta,
        finish_reason: null,
      },
    ],
  };
}

/**
 * 生成流式结束 chunk
 */
export function createStreamEndChunk(
  id: string,
  model: string = 'gpt-3.5-turbo'
): OpenAIStreamChunk {
  return {
    id: id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop',
      },
    ],
  };
}

// ==================== 流式处理器 ====================

/**
 * CodeArts SSE 流处理器
 * 模拟源项目的 SSE 处理逻辑
 */
export class CodeArtsStreamProcessor {
  private model: string;
  private buffer: string = '';
  private isFirstChunk: boolean = true;
  private messageId: string = '';
  private accumulatedText: string = '';

  constructor(model: string = 'gpt-3.5-turbo') {
    this.model = model;
  }

  /**
   * 处理 SSE 数据块
   * 返回 OpenAI 格式的 chunk 或 null（如果数据不完整）
   */
  processChunk(data: string): OpenAIStreamChunk | null {
    // 尝试解析 JSON
    try {
      const parsed = JSON.parse(data) as CodeArtsStreamChunk;
      
      // 更新消息 ID
      if (parsed.id) {
        this.messageId = parsed.id;
      }
      if (parsed.response_message_id) {
        this.messageId = parsed.response_message_id;
      }

      // 累积文本
      if (parsed.text) {
        this.accumulatedText += parsed.text;
      }

      // 转换为 OpenAI 格式
      const openaiChunk = codeArtsChunkToOpenAI(parsed, this.model, this.isFirstChunk);
      this.isFirstChunk = false;

      return openaiChunk;
    } catch (error) {
      // JSON 解析失败，可能是数据不完整
      return null;
    }
  }

  /**
   * 获取最终的完整响应
   */
  getFinalResponse(): OpenAICompletionResponse {
    return {
      id: this.messageId || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: this.accumulatedText,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: estimateTokens(this.accumulatedText),
        total_tokens: estimateTokens(this.accumulatedText),
      },
    };
  }

  /**
   * 获取结束 chunk
   */
  getEndChunk(): OpenAIStreamChunk {
    return createStreamEndChunk(this.messageId, this.model);
  }

  /**
   * 重置处理器状态
   */
  reset(): void {
    this.buffer = '';
    this.isFirstChunk = true;
    this.messageId = '';
    this.accumulatedText = '';
  }
}

// ==================== 错误处理 ====================

/**
 * 将 CodeArts 错误转换为 OpenAI 错误格式
 */
export function convertError(codeartsError: {
  error_code: string;
  error_msg?: string;
}): {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string;
  };
} {
  const { error_code, error_msg } = codeartsError;

  // 错误码映射
  const errorMapping: Record<string, { type: string; message: string }> = {
    '0': { type: 'none', message: '' },
    'IAM.1201': { type: 'permission_error', message: 'Token is disabled by administrator' },
    'not programmatic access': { type: 'permission_error', message: 'User only supports console access' },
    'Login Timeout': { type: 'authentication_error', message: 'Session has expired' },
    'Account Locked': { type: 'account_error', message: 'Account is locked, try again in 15 minutes' },
    'Account Disabled': { type: 'account_error', message: 'Account is disabled' },
  };

  const mappedError = errorMapping[error_code] || {
    type: 'api_error',
    message: error_msg || 'Unknown error occurred',
  };

  return {
    error: {
      message: mappedError.message,
      type: mappedError.type,
      param: null,
      code: error_code,
    },
  };
}

// ==================== 辅助函数 ====================

/**
 * 简单的 token 估算
 * 实际应使用与源项目相同的 tokenizer
 */
function estimateTokens(text: string): number {
  // 简单估算：平均每 4 个字符约 1 个 token
  return Math.ceil(text.length / 4);
}

/**
 * 解析 SSE 事件流
 * 从原始 SSE 数据中提取 JSON 数据
 */
export function parseSSELine(line: string): { event: string; data: string } | null {
  // SSE 格式: event: xxx\ndata: xxx\n\n
  if (!line || line.trim() === '') {
    return null;
  }

  const eventMatch = line.match(/^event:\s*(.+)$/);
  const dataMatch = line.match(/^data:\s*(.+)$/);

  if (dataMatch) {
    return {
      event: eventMatch ? eventMatch[1] : 'message',
      data: dataMatch[1],
    };
  }

  return null;
}

/**
 * OpenAI 格式的 SSE 格式化
 */
export function formatAsSSE(data: OpenAIStreamChunk | OpenAICompletionResponse): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * 格式化结束事件
 */
export function formatEndEvent(): string {
  return 'data: [DONE]\n\n';
}

// ==================== 导出 ====================

export default {
  codeArtsToOpenAI,
  codeArtsChunkToOpenAI,
  createStreamEndChunk,
  CodeArtsStreamProcessor,
  convertError,
  parseSSELine,
  formatAsSSE,
  formatEndEvent,
};