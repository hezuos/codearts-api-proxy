## Context

`return-cache-token-usage` change 已让 proxy 在 usage 顶层返回 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `cache_estimated`。`computeCacheUsage`（`chat-request.ts:118`）返回 `{ prompt_cache_hit_tokens, prompt_cache_miss_tokens, cache_estimated }`，`chat.ts:226` 和 `chat-stream.ts` 的 usage chunk 通过 `...cacheUsage` 展开。

实测 new-api 日志"缓存↓"列为空。调研 new-api 源码（`QuantumNous/new-api`，clone at `D:/Temp/new-api`）确认数据链路：

```
前端 "缓存↓" 列 (common-logs-columns.tsx:660)
  └─ other.cache_tokens (log_info_generate.go:78)
       └─ summary.CacheTokens (text_quota.go:260)
            └─ usage.PromptTokensDetails.CachedTokens  ← 只读 prompt_tokens_details.cached_tokens
```

`applyUsagePostProcessing`（`relay/channel/openai/usage.go:10`）按 `ChannelType` 分支，只有 `DeepSeek` / `Zhipu_v4` / `Moonshot` 会把顶层 `prompt_cache_hit_tokens` 拷贝到 `PromptTokensDetails.CachedTokens`。`OpenAI` 分支只读 llama.cpp 的 `timings.cache_n`；`Custom` (8) / `AdvancedCustom` (58) / `OpenRouter` (20) 无 case，走 default 完全不处理。proxy 在 new-api 通常配成 OpenAI 或 Custom 渠道，因此顶层 `prompt_cache_hit_tokens` 永远到不了 `summary.CacheTokens`。

## Goals / Non-Goals

**Goals:**
- 让 new-api（及任何读 OpenAI 标准 `prompt_tokens_details.cached_tokens` 的网关）在不改渠道类型、不改 new-api 代码的前提下展示缓存命中数
- 保持 DeepSeek 原生客户端兼容（顶层 `prompt_cache_hit_tokens` 仍返回）
- 非流式和流式路径都补 `prompt_tokens_details` 嵌套结构

**Non-Goals:**
- 不改 new-api 源码（不给 `applyUsagePostProcessing` 的 OpenAI/Custom 分支加 fallback）—— 路径 A 在 proxy 侧完全解决
- 不改 `computeCacheUsage` 的估算逻辑（divergence + parent + isToolContinuation 组合判断不变）
- 不改 `total_tokens` 语义
- 不新增 `completion_tokens_details`（输出端无缓存概念）

## Decisions

### D1: `computeCacheUsage` 返回值增加 `prompt_tokens_details` 字段

**选择：** 返回值从 `{ prompt_cache_hit_tokens, prompt_cache_miss_tokens, cache_estimated }` 扩展为 `{ prompt_cache_hit_tokens, prompt_cache_miss_tokens, prompt_tokens_details: { cached_tokens, text_tokens }, cache_estimated }`，其中 `prompt_tokens_details.cached_tokens = prompt_cache_hit_tokens`，`prompt_tokens_details.text_tokens = prompt_cache_miss_tokens`。

**理由：** 两处值始终相等（都是 `cacheHit` 和 `max(0, promptTokens - cacheHit)`），在 `computeCacheUsage` 一处计算两处输出，避免调用方重复拼装。`...cacheUsage` 展开时 `prompt_tokens_details` 作为嵌套对象整体注入 usage。

**备选：** 在 `chat.ts` / `chat-stream.ts` 调用方手动拼 `prompt_tokens_details`。否决——两处调用方重复逻辑，且 `computeCacheUsage` 已经持有 `cacheHit` / `cacheMiss`，在源头输出更内聚。

### D2: `OpenAIUsage` 类型扩展 `prompt_tokens_details`

**选择：** 用 `Omit` 精确覆盖 `prompt_tokens_details`，避免 intersection 对同名嵌套字段做交叉导致语义混乱：
```typescript
OpenAIUsage = Omit<CompletionUsage, 'prompt_tokens_details'> & {
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  cache_estimated?: boolean;
  prompt_tokens_details?: {
    cached_tokens?: number;
    text_tokens?: number;
    audio_tokens?: number;
    cache_write_tokens?: number;
  };
}
```

**理由：** OpenAI 官方 `CompletionUsage` 已有 `prompt_tokens_details?: PromptTokensDetails`（含 `cached_tokens` / `audio_tokens` / `cache_write_tokens`，但不含 `text_tokens`）。若直接 intersection `CompletionUsage & { prompt_tokens_details?: { cached_tokens?: number; text_tokens?: number } }`，TS 会对同名 `prompt_tokens_details` 字段做类型交叉，最终类型是 `{ cached_tokens?: number; audio_tokens?: number; cache_write_tokens?: number } & { cached_tokens?: number; text_tokens?: number }`——`text_tokens` 可访问但语义混乱。用 `Omit<CompletionUsage, 'prompt_tokens_details'>` 先剔除官方的 `prompt_tokens_details`，再重新声明含 `text_tokens` 的版本，类型清晰。`audio_tokens` / `cache_write_tokens` 保留以兼容官方语义。

### D3: `OpenAIChatCompletion` 覆盖 usage 字段类型

**选择：** `OpenAIChatCompletion` 当前是 `ChatCompletion & { codearts? }`，未覆盖 usage 字段，导致 `usage` 类型仍是 `CompletionUsage` 而非 `OpenAIUsage`。改为：
```typescript
OpenAIChatCompletion = ChatCompletion & {
  codearts?: OpenAICodeArtsResponseMetadata;
  usage?: OpenAIUsage;  // 覆盖，让非流式 usage 支持扩展字段
};
```

**理由：** `return-cache-token-usage` 的 D6 只覆盖了 `OpenAIChatCompletionChunk.usage`，遗漏了 `OpenAIChatCompletion.usage`。当前 `chat.ts:226` 用 `...cacheUsage` 展开注入扩展字段能编译通过，仅因为 TS 对展开运算符不做 excess property check——类型声明与运行时数据不一致，是类型安全隐患。本 change 加 `prompt_tokens_details.text_tokens` 后，若不覆盖 `OpenAIChatCompletion.usage`，下游代码 `response.usage.prompt_tokens_details.text_tokens` 会报 TS 错误。覆盖后 `OpenAIChatCompletion` 与 `OpenAIChatCompletionChunk` 的 usage 类型统一为 `OpenAIUsage`。

**备选：** 保持现状靠展开绕过 excess check。否决——类型不安全，且 `text_tokens` 在类型上不可见，下游无法安全访问。

### D4: 流式 usage chunk 同步嵌套

**选择：** `chat-stream.ts` 构造最终 usage chunk 时，usage 对象同样通过 `...cacheUsage` 展开，`prompt_tokens_details` 自动注入。

**理由：** new-api 的 `handleLastResponse`（`helper.go:134`）把最后一个 chunk 的 `usage` 整个反序列化赋给 `*usage`，`prompt_tokens_details.cached_tokens` 会直接填入 `usage.PromptTokensDetails.CachedTokens`。流式与非流式走同一条 `computeCacheUsage` 输出路径，保证一致。

### D5: `setLastPromptTokens` 调用顺序——必须在 `computeCacheUsage` 之后（或先快照再 set）

**选择：**
- **非流式（`chat.ts`）**：`computeCacheUsage(promptTokens, getLastPromptTokens(cid), ...)` 先执行，`setLastPromptTokens(cid, promptTokens)` 后执行
- **流式（`chat-stream.ts`）**：先快照 `prevPromptTokens = getLastPromptTokens(cid)`，再 `setLastPromptTokens(cid, promptTokens)`，再 `computeCacheUsage(promptTokens, prevPromptTokens, ...)` 用快照

**理由：** `computeCacheUsage` 用 `prevPromptTokens`（上一轮的 `prompt_tokens`）估算本轮缓存命中。若 `setLastPromptTokens` 在 `computeCacheUsage` 之前调用，`getLastPromptTokens(cid)` 读到的是本轮刚写入的值，`cacheHit = prevPromptTokens = promptTokens`，`cacheMiss = max(0, promptTokens - cacheHit) = 0`——即缓存命中永远等于 input tokens、miss 永远为 0，new-api "缓存↓"列显示值始终等于 input tokens，缓存估算完全失效。

**流式为何用快照而非直接后移：** 流式路径中 `setLastPromptTokens` 在 SSE 循环结束、构造 usage chunk 之前就执行了（`chat-stream.ts:439-441`），而 `computeCacheUsage` 在 `include_usage` 分支里才调用（`chat-stream.ts:469-476`）。若直接把 `setLastPromptTokens` 移到 `computeCacheUsage` 之后，当 `include_usage=false` 时 `setLastPromptTokens` 不会执行，下一轮估算丢失本轮记录。快照方案解耦了"记录本轮值"和"读取上一轮值"的时序，两者都能在正确时机执行。

**备选：** 把 `setLastPromptTokens` 移到 `computeCacheUsage` 之后（非流式方案）。流式否决——见上。非流式可行但与流式方案不一致，快照方案在两处统一更易维护。最终非流式选直接后移（代码更简单），流式选快照（时序约束使然）。

**回归守卫：** `cache-usage.test.ts` 的 `testNonStreamingCallOrder` / `testStreamingCallOrder` 模拟真实调用顺序，带 `assert.notEqual(cacheHit, promptTokens)` 防止顺序倒退。

## Risks / Trade-offs

- **[字段冗余]** usage 同时返回顶层和嵌套两套缓存字段，体积略增 → 可忽略（几个数字字段），且两套字段服务不同消费者，无法省略
- **[new-api 版本差异]** 未来 new-api 可能改 `applyUsagePostProcessing` 让 OpenAI 分支也读顶层 `prompt_cache_hit_tokens` → 双字段返回是超集，任何一种读取方式都能命中，前向兼容
- **[`text_tokens` 语义]** OpenAI 官方 `prompt_tokens_details` 不含 `text_tokens`（只有 `cached_tokens` + `audio_tokens`），我们加的 `text_tokens` 是非标准扩展 → new-api 的 `InputTokenDetails` 结构体有 `TextTokens json:"text_tokens"` 字段会接收；其他严格按 OpenAI schema 校验的客户端会忽略未知字段。可接受
- **[`text_tokens` 对 new-api 计费无作用]** 调研 `text_quota.go:260-315` 确认 new-api 计费只读 `cached_tokens`（`summary.CacheTokens = usage.PromptTokensDetails.CachedTokens`，然后 `baseTokens.Sub(dCacheTokens)` 按缓存价算），**完全不读 `text_tokens`**。`text_tokens` 仅为 OpenAI 语义完整性（`text_tokens = prompt_tokens - cached_tokens`），对 new-api 日志展示和计费无影响，填或不填均可。选择填是为了让直接连 proxy 的客户端拿到完整语义
- **[估算精度不变]** 本 change 不改估算逻辑，`return-cache-token-usage` 的所有估算偏差风险（工具续传改写、热链分叉、chat_id 跳轮、进程重启）原样继承 → `cache_estimated: true` 标记仍告知客户端这是估算值
