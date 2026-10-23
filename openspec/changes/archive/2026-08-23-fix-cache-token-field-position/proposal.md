## Why

`return-cache-token-usage` change 让 proxy 在 usage 顶层返回 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（DeepSeek 风格）。但实测 new-api 日志界面"缓存↓"列始终为空——调研 new-api 源码（`QuantumNous/new-api`）发现其计费和日志只读 `usage.prompt_tokens_details.cached_tokens`（OpenAI 标准位置），且 `applyUsagePostProcessing` 的 `OpenAI` / `Custom` / `AdvancedCustom` 分支不会把顶层 `prompt_cache_hit_tokens` 拷贝到 `prompt_tokens_details.cached_tokens`（只有 DeepSeek/Zhipu/Moonshot 分支会）。proxy 在 new-api 里通常配成 OpenAI 或 Custom 渠道，因此缓存值永远到不了日志列。

## What Changes

- usage 同时返回两套缓存字段：保留顶层 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（DeepSeek 原生客户端兼容），**新增** `prompt_tokens_details.cached_tokens` + `prompt_tokens_details.text_tokens`（OpenAI 标准位置，new-api 直接读）
- 非流式响应（`chat.ts`）和流式 usage chunk（`chat-stream.ts`）都补上 `prompt_tokens_details` 嵌套结构
- `OpenAIUsage` 类型扩展 `prompt_tokens_details?: { cached_tokens?: number; text_tokens?: number }` 字段
- `computeCacheUsage` 返回值增加 `prompt_tokens_details` 字段，`cache_estimated` 标记保留
- **修正 `setLastPromptTokens` 调用顺序**：非流式（`chat.ts`）移到 `computeCacheUsage` **之后**调用；流式（`chat-stream.ts`）先快照 `prevPromptTokens = getLastPromptTokens(cid)`，再 `setLastPromptTokens`，再 `computeCacheUsage` 用快照。否则 `getLastPromptTokens` 读到本轮刚写入的值，导致 `cacheHit` 永远等于 `promptTokens`、`cacheMiss` 永远为 0（即 new-api "缓存↓"列显示值始终等于 input tokens）

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `openai-api`: chat completions 响应 usage 新增 `prompt_tokens_details.cached_tokens` / `prompt_tokens_details.text_tokens`，让 new-api 等读 OpenAI 标准位置的网关能展示缓存命中数
- `sse-streaming`: 流式 usage chunk 同步补 `prompt_tokens_details` 嵌套结构

## Impact

- **代码**：`src/types/openai.ts`（`OpenAIUsage` 用 `Omit` 精确覆盖 `prompt_tokens_details` 含 `text_tokens`；`OpenAIChatCompletion` 覆盖 `usage` 为 `OpenAIUsage` 修复类型安全隐患）、`src/upstream/huawei/chat-request.ts`（`computeCacheUsage` 返回值扩展 `prompt_tokens_details`）、`src/upstream/huawei/chat.ts`（usage 构造，运行时 `...cacheUsage` 已覆盖，类型由 `OpenAIChatCompletion.usage` 保证）、`src/upstream/huawei/chat-stream.ts`（流式 usage chunk，同理）
- **API**：usage 对象新增 `prompt_tokens_details` 嵌套字段，向后兼容（旧客户端忽略未知字段；DeepSeek 原生客户端仍可读顶层 `prompt_cache_hit_tokens`）
- **new-api 兼容性**：JSON 反序列化会直接把 `prompt_tokens_details.cached_tokens` 填入 `usage.PromptTokensDetails.CachedTokens`，`summary.CacheTokens` 即有值，日志"缓存↓"列正常展示，无需改 new-api 渠道类型或给 new-api 提 PR
- **依赖**：无新增依赖
