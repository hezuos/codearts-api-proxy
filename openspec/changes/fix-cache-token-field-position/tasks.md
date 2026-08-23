## 1. 类型扩展

- [x] 1.1 在 `src/types/openai.ts` 的 `OpenAIUsage` 类型中用 `Omit<CompletionUsage, 'prompt_tokens_details'>` 精确覆盖 `prompt_tokens_details`，声明为 `{ cached_tokens?: number; text_tokens?: number; audio_tokens?: number; cache_write_tokens?: number }`（与现有 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `cache_estimated` 并列）
- [x] 1.2 在 `src/types/openai.ts` 的 `OpenAIChatCompletion` 类型中覆盖 `usage` 字段为 `OpenAIUsage`（当前仅 `OpenAIChatCompletionChunk` 覆盖了，`OpenAIChatCompletion` 遗漏——修复 `return-cache-token-usage` D6 的类型安全隐患）

## 2. computeCacheUsage 返回值扩展

- [x] 2.1 在 `src/upstream/huawei/chat-request.ts` 的 `computeCacheUsage` 返回类型中增加 `prompt_tokens_details: { cached_tokens: number; text_tokens: number }` 字段
- [x] 2.2 在返回值构造处令 `prompt_tokens_details.cached_tokens = cacheHit`、`prompt_tokens_details.text_tokens = cacheMiss`（与顶层 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 同值）

## 3. 非流式响应集成

- [x] 3.1 确认 `src/upstream/huawei/chat.ts` 的 usage 构造处（约 L226 `...cacheUsage`）展开后 `prompt_tokens_details` 自动注入 usage 顶层（运行时无需额外改动，`...cacheUsage` 已覆盖；类型安全性由任务 1.2 保证）

## 4. 流式响应集成

- [x] 4.1 确认 `src/upstream/huawei/chat-stream.ts` 的最终 usage chunk 构造处同样通过 `...cacheUsage` 展开，`prompt_tokens_details` 自动注入（运行时无需额外改动；`OpenAIChatCompletionChunk.usage` 已是 `OpenAIUsage`，类型安全）

## 5. 测试

- [x] 5.1 在现有 `cache-usage.test.ts` 测试中**新增**断言：`r.prompt_tokens_details.cached_tokens` 和 `r.prompt_tokens_details.text_tokens`，且与顶层 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 同值（现有 `assert.equal` 逐字段断言不会因新增字段失败，覆盖 cold-start、normal 续传、tail-divergence、middle-damage、duplicate/stale、tool continuation、无记录、clamp 到 0 全部场景）
- [x] 5.2 新建非流式集成测试（`chat.test.ts` 当前无 cache/usage 断言，`return-cache-token-usage` 的集成测试未落地）：断言响应 `usage.prompt_tokens_details.cached_tokens` 在各 divergence 场景下有正确值。**测试文件位置**：加到 `cache-usage.test.ts`（已在 `package.json` test script 串联中，无需改 package.json）；若新建独立文件，必须追加到 `package.json` 的 `test` script 串联链，否则 `pnpm test` 不会执行
- [x] 5.3 新建流式集成测试：`include_usage=true` 时收到的 usage chunk 包含 `prompt_tokens_details.cached_tokens`。**测试文件位置**：同 5.2，优先加到 `cache-usage.test.ts`
- [x] 5.4 运行 `pnpm test` 与 `pnpm run lint` 确认无回归

## 6. setLastPromptTokens 调用顺序修正

> **背景：** v2.2.2 发布后发现 new-api "缓存↓"列显示值始终等于 input tokens。根因是 `setLastPromptTokens` 在 `computeCacheUsage` 之前调用，`getLastPromptTokens` 读到本轮刚写入的值，`cacheHit` 永远等于 `promptTokens`。本组任务修正调用顺序并加回归守卫。

- [x] 6.1 在 `src/upstream/huawei/chat.ts` 中把 `setLastPromptTokens(cid, promptTokens)` 移到 `computeCacheUsage(...)` **之后**调用（非流式路径）
- [x] 6.2 在 `src/upstream/huawei/chat-stream.ts` 中先快照 `prevPromptTokens = getLastPromptTokens(cid)`，再 `setLastPromptTokens(cid, promptTokens)`，再 `computeCacheUsage(promptTokens, prevPromptTokens, ...)` 用快照（流式路径——`setLastPromptTokens` 在 usage chunk 构造前执行，无法像非流式简单后移）
- [x] 6.3 在 `cache-usage.test.ts` 新增 `testNonStreamingCallOrder` / `testStreamingCallOrder`：模拟真实调用顺序，断言 `cacheHit` 等于上一轮 `promptTokens`（非本轮），带 `assert.notEqual(cacheHit, promptTokens)` 回归守卫
- [x] 6.4 运行 `pnpm test` 确认调用顺序测试通过，无回归
