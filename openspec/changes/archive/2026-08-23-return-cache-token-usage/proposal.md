## Why

华为云上游 SSE 响应只返回 `prompt_tokens` / `completion_tokens` / `total_tokens`，不区分缓存命中与未命中。但 DeepSeek 等下游客户端按 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 分别计费——缓存命中价格低于未命中。当前 proxy 在 `chat.ts:201` 构造的 usage 只有三个标准字段，流式响应（`chat-stream.ts`）甚至完全不发 usage chunk，导致客户端无法核算缓存计费。

华为云的 `parent_message_id` 续传机制让服务端复用上一轮 prompt 前缀，因此**上一轮的 `prompt_tokens` 可近似当作本轮的缓存命中数**。基于此估算，proxy 可以补全 DeepSeek 风格的缓存字段，让客户端能算钱。

## What Changes

- 新增按 `chat_id` 记录上一轮 `prompt_tokens` 的内存 Map（带 TTL 清理，复用 `chat-request.ts` 现有清理循环）
- 在 `buildRequestBody` 返回值中增加 `isToolContinuation` 字段（内部已计算，未导出）
- 非流式响应（`chat.ts`）构造 usage 时，用 `divergence` + `parent_message_id` + `isToolContinuation` 三信号组合判断缓存命中，填 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（DeepSeek 风格，usage 顶层）
- 流式响应（`chat-stream.ts`）在 `[DONE]` 前补发带 usage 的最终 chunk（仅当 `stream_options.include_usage=true`，遵循 OpenAI 协议）
- usage 增加 `cache_estimated: true` 标记，告知客户端这是估算值而非上游真实缓存命中数
- `OpenAIUsage` 类型扩展缓存字段

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `openai-api`: chat completions 响应的 usage 字段新增 DeepSeek 风格缓存计费字段（`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `cache_estimated`），基于上一轮 prompt_tokens 估算
- `sse-streaming`: 流式响应在 `stream_options.include_usage=true` 时补发带 usage 的最终 chunk（当前完全不发）

## Impact

- **代码**：`src/upstream/huawei/chat-request.ts`（新增 Map + getter/setter + TTL + isToolContinuation 导出）、`src/upstream/huawei/chat.ts`（usage 构造）、`src/upstream/huawei/chat-stream.ts`（流式 usage chunk）、`src/types/openai.ts`（`OpenAIUsage` / `OpenAIChatCompletionChunk` / `OpenAIChatCompletionRequest` 三处类型扩展）
- **API**：OpenAI 兼容响应的 `usage` 对象新增三个字段，向后兼容（旧客户端忽略未知字段）
- **精度**：估算值在工具调用续传、热链分叉修复、子代理、chat_id 跳轮等场景下可能偏高/偏低，由 `cache_estimated: true` 标记告知客户端
- **依赖**：无新增依赖
