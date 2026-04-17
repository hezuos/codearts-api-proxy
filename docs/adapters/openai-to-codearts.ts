/**
 * OpenAI 到 CodeArts 请求转换器
 * 基于源项目分析：D:/Program Files/CodeArts Agent
 * 参考：docs/codearts-agent-auth-and-requuest-mechanism.md
 */

import { v4 as uuidv4 } from 'uuid';

// ==================== 类型定义 ====================

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'function' | 'tool';
  content: string | null;
  name?: string;
  function_call?: { name: string; arguments: string };
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[];
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  functions?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>;
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>;
}

interface CodeArtsMessage {
  type: string;
  value: { input: string } | Record<string, unknown>;
}

interface CodeArtsRequest {
  chat_id: string;
  messages: CodeArtsMessage[];
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

// ==================== 模型映射 ====================

const MODEL_MAPPING: Record<string, { codeartsModelId: string; agentId?: string }> = {
  'gpt-4': { codeartsModelId: 'GLM-5.1', agentId: 'CodeAgent' },
  'gpt-4-turbo': { codeartsModelId: 'GLM-5.1', agentId: 'CodeAgent' },
  'gpt-3.5-turbo': { codeartsModelId: 'GLM-5.1', agentId: 'CodeAgent' },
  'glm-5': { codeartsModelId: 'GLM-5.1', agentId: 'CodeAgent' },
  'glm-5.1': { codeartsModelId: 'GLM-5.1', agentId: 'CodeAgent' },
  'codeagent': { codeartsModelId: 'GLM-5.1', agentId: 'CodeAgent' },
  'codemate': { codeartsModelId: 'GLM-5.1', agentId: 'CodeMate' },
  'devmate': { codeartsModelId: 'GLM-5.1', agentId: 'DevMate' },
};

// ==================== 转换函数 ====================

/**
 * 将 OpenAI 格式的消息转换为 CodeArts 格式
 */
function convertMessages(openaiMessages: OpenAIMessage[]): CodeArtsMessage[] {
  return openaiMessages.map((msg) => {
    // 处理不同角色的消息
    let content = '';
    
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (msg.content === null) {
      // 处理 function call 或 tool calls
      if (msg.function_call) {
        content = `Function call: ${msg.function_call.name}(${msg.function_call.arguments})`;
      } else if (msg.tool_calls && msg.tool_calls.length > 0) {
        content = msg.tool_calls
          .map((tc) => `Tool call: ${tc.function.name}(${tc.function.arguments})`)
          .join('\n');
      }
    }

    return {
      type: 'text',
      value: {
        input: content,
      },
    };
  });
}

/**
 * 将 OpenAI 请求转换为 CodeArts 请求
 * 基于源项目 vscode-codebot/out/extension.js 中的 generateRequestBody 函数
 */
export function openAIToCodeArts(
  openaiRequest: OpenAIRequest,
  options: {
    chatId?: string;
    userId?: string;
    sessionId?: string;
    parentMessageId?: string;
  } = {}
): CodeArtsRequest {
  const { model, messages, stream, user, max_tokens } = openaiRequest;

  // 获取模型映射
  const normalizedModel = model.toLowerCase();
  const modelConfig = MODEL_MAPPING[normalizedModel] || MODEL_MAPPING['gpt-3.5-turbo'];

  // 生成或使用提供的 chat_id
  const chatId = options.chatId || uuidv4();

  // 转换消息
  const codeartsMessages = convertMessages(messages);

  // 构建 CodeArts 请求体
  const codeartsRequest: CodeArtsRequest = {
    chat_id: chatId,
    messages: codeartsMessages,
    client: 'OPENAI_PROXY', // 标识请求来源
    task: 'chat', // 默认任务类型
    task_parameters: {
      // 根据源项目分析，task_parameters 可包含以下字段
      codebase_search: false,
      trigger_mode: 'API_CALL',
    },
    batch_task_parameters: [],
    attempt: 0,
    user_id: options.userId || user || 'proxy_user',
    trigger_mode: 'API_CALL',
    is_delta_response: !!stream, // 流式请求使用 delta 模式
    model_id: modelConfig.codeartsModelId,
    agent_id: modelConfig.agentId,
  };

  // 添加父消息 ID（用于多轮对话）
  if (options.parentMessageId) {
    codeartsRequest.parent_message_id = options.parentMessageId;
  }

  // 添加 max_tokens 约束（如果指定）
  if (max_tokens) {
    codeartsRequest.task_parameters = {
      ...codeartsRequest.task_parameters,
      max_tokens: max_tokens,
    };
  }

  return codeartsRequest;
}

/**
 * 转换请求头
 * 源项目使用 toolkit 注入 token，这里需要手动添加认证头
 */
export function convertHeaders(authToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Auth-Token': authToken, // 从源项目的 toolkit 获取
    'X-Request-Id': uuidv4(), // 追踪 ID
    'X-Snap-Traceid': uuidv4(), // 源项目使用的追踪标识
  };
}

/**
 * 构建完整的 CodeArts API 请求配置
 */
export function buildCodeArtsRequestConfig(
  openaiRequest: OpenAIRequest,
  authToken: string,
  baseUrl: string = 'https://snap-access.cn-north-4.myhuaweicloud.com',
  options?: {
    chatId?: string;
    userId?: string;
    sessionId?: string;
    parentMessageId?: string;
  }
): {
  url: string;
  method: string;
  headers: Record<string, string>;
  data: CodeArtsRequest;
} {
  const codeartsRequest = openAIToCodeArts(openaiRequest, options);
  const headers = convertHeaders(authToken);

  return {
    url: `${baseUrl}/v1/chat/chat`,
    method: 'POST',
    headers,
    data: codeartsRequest,
  };
}

// ==================== 辅助函数 ====================

/**
 * 检测任务类型（基于消息内容）
 * 源项目支持多种任务类型：chat, code-explain, code-comment, etc.
 */
export function detectTaskType(messages: OpenAIMessage[]): string {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || typeof lastMessage.content !== 'string') {
    return 'chat';
  }

  const content = lastMessage.content.toLowerCase();

  // 简单的关键词检测
  if (content.includes('explain') || content.includes('解释')) {
    return 'code-explain';
  }
  if (content.includes('comment') || content.includes('注释')) {
    return 'code-comment';
  }
  if (content.includes('debug') || content.includes('调试')) {
    return 'code-debug';
  }
  if (content.includes('optimize') || content.includes('优化')) {
    return 'code-optimize';
  }
  if (content.includes('test') || content.includes('测试')) {
    return 'ut-generate';
  }

  return 'chat';
}

/**
 * 生成会话管理信息
 */
export function generateSessionInfo(): {
  chatId: string;
  sessionId: string;
} {
  return {
    chatId: uuidv4(),
    sessionId: `session_${Date.now()}_${uuidv4().substring(0, 8)}`,
  };
}

export default {
  openAIToCodeArts,
  convertHeaders,
  buildCodeArtsRequestConfig,
  detectTaskType,
  generateSessionInfo,
  MODEL_MAPPING,
};