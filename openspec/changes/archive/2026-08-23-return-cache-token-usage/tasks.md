## 1. 类型扩展

- [x] 1.1 在 `src/types/openai.ts` 扩展：
  - `OpenAIUsage = CompletionUsage & { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; cache_estimated?: boolean }`
  - `OpenAIChatCompletionRequest` 增加 `stream_options?: { include_usage?: boolean | null } | null`（OpenAI 官方协议字段，当前类型缺失）
  - `OpenAIChatCompletionChunk` 扩展为 `ChatCompletionChunk & { codearts?: ...; usage?: OpenAIUsage | null }`（覆盖 usage 字段类型，让流式 chunk 支持缓存字段）

## 2. prompt_tokens 追踪基础设施

- [x] 2.1 在 `src/upstream/huawei/chat-request.ts` 新增 `lastPromptTokens: Map<string, number>` 及配套时间戳 Map
- [x] 2.2 将 `lastPromptTokens` 加入现有 `cleanupTimer` 的 TTL 清理分支
- [x] 2.3 导出 `getLastPromptTokens(chatId): number | undefined` 和 `setLastPromptTokens(chatId, tokens): void`

## 3. 缓存字段计算工具

- [x] 3.1 在 `buildRequestBody` 返回值中增加 `isToolContinuation` 字段（内部已计算于 `chat-request.ts:258`，未导出）
- [x] 3.2 新增 `computeCacheUsage(promptTokens, prevPromptTokens, divergence, hasParent, isToolContinuation): { prompt_cache_hit_tokens, prompt_cache_miss_tokens, cache_estimated }`，封装组合判断逻辑：
  - `normal` / `tail-divergence` / `duplicate/stale` + 有 parent → cache_hit = prevPromptTokens
  - `middle-damage` / `undefined` → cache_hit = 0
  - 无 parent + isToolContinuation → cache_hit = prevPromptTokens
  - 无 parent + 非 tool continuation → cache_hit = 0
  - cache_miss = max(0, promptTokens - cache_hit)

## 4. 非流式响应集成

- [x] 4.1 在 `src/upstream/huawei/chat.ts` 构造 usage 处（约 L201）调用 `computeCacheUsage`，传入 `divergence`（L46 已解构）、`requestBody.parent_message_id`、`isToolContinuation`（从 buildRequestBody 新增返回值获取）
- [x] 4.2 在响应成功完成后（`responseMetadata.response_message_id` 存在且 `promptTokens > 0` 时）调用 `setLastPromptTokens(cid, promptTokens)`（guard promptTokens > 0 避免存 0 污染下一轮估算）

## 5. 流式响应集成

- [x] 5.1 在 `src/upstream/huawei/chat-stream.ts` 累积 `prompt_tokens` / `completion_tokens`（当前完全不处理）
- [x] 5.2 响应成功完成后（`promptTokens > 0` 时）调用 `setLastPromptTokens(cid, promptTokens)`
- [x] 5.3 检查 `request.stream_options?.include_usage`，为 true 时在 `[DONE]` 前补发 `choices: []` + `usage`（含缓存字段，传入 `initialDivergence`（L62 已解构）、`requestBody.parent_message_id`、`isToolContinuation`）的最终 chunk
- [x] 5.4 `include_usage` 为 false/ absent 时保持当前行为（不发 usage chunk）

## 6. 测试

- [x] 6.1 为 `computeCacheUsage` 写单元测试：cold-start、normal 续传、tail-divergence、middle-damage、duplicate/stale、tool continuation、无记录、clamp 到 0
- [x] 6.2 为 `getLastPromptTokens` / `setLastPromptTokens` 写单元测试：存取 + TTL 清理
- [x] 6.3 非流式集成测试：各 divergence 场景下 usage 包含正确的 cache_hit / cache_miss / cache_estimated
- [x] 6.4 流式集成测试：`include_usage=true` 时收到 usage chunk，`include_usage=false` 时不收
- [x] 6.5 运行 `pnpm test` 与 `pnpm run lint` 确认无回归
