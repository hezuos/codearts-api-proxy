## Context

当前 `chat.ts:210` 构造的 usage 只有 `prompt_tokens` / `completion_tokens` / `total_tokens` 三个标准字段。流式路径 `chat-stream.ts` 完全不发 usage chunk，直接 `[DONE]` 结尾。

`chat-request.ts:52` 已有 `lastResponseMessageId: Map<chat_id, message_id>` 及配套 TTL 清理（4h TTL，10min 清理间隔），用于追踪续传链。同文件还有 `chainStates`、`chatIdRole` 等 Map 共享同一清理循环。

华为云上游 SSE 事件（`CodeArtsSSEEvent` in `chat-protocol.ts:19`）只暴露 `prompt_tokens` / `completion_tokens` / `total_tokens`，无缓存命中/未命中字段（已查证抓包样本与 `token-analysis-runtime.md:116`）。

`OpenAIUsage`（`types/openai.ts:96`）当前是 `CompletionUsage` 的类型别名。

## Goals / Non-Goals

**Goals:**
- 让非流式和流式响应都返回 DeepSeek 风格的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `cache_estimated`
- 基于上一轮 `prompt_tokens` 估算缓存命中，复用现有 `chat_id` 追踪机制
- 流式响应在 `stream_options.include_usage=true` 时补发 usage chunk

**Non-Goals:**
- 不精确计算真实缓存命中数（上游不提供）
- 不持久化 prompt_tokens 到磁盘（进程重启即丢失，与 `lastResponseMessageId` 一致）
- 不修改上游请求构造（不向上游索要缓存字段）
- 不改变 `total_tokens` 语义（仍 = prompt_tokens + completion_tokens，不含缓存折扣）

## Decisions

### D1: 用 divergence + parentMessageId + isToolContinuation 组合判断缓存命中

**选择：** 复用 `buildRequestBody` 已计算的 `divergence`（`chat-request.ts:422` 返回，`chat.ts:46` / `chat-stream.ts:62` 已解构）+ `requestBody.parent_message_id` + `isToolContinuation` 三信号组合，决定 `cache_hit`：

| divergence | parent 非空 | isToolContinuation | cache_hit | 说明 |
|------------|-----------|-------------------|-----------|------|
| `normal` | ✓ | — | `lastPromptTokens` | 前缀哈希匹配，真续传，服务端复用上轮前缀 |
| `tail-divergence` | ✓ | — | `lastPromptTokens` | 前缀仍匹配，仅尾部新增，前缀缓存命中 |
| `duplicate/stale` | ✓ | — | `lastPromptTokens` | 重复请求，全缓存命中 |
| `middle-damage` / `undefined` | — | — | `0` | 前缀不匹配或全量重置（forceResync），无缓存 |
| — | ✗ | ✓ | `lastPromptTokens` | 工具续传：messagesBody=[]，服务端复用上轮完整上下文 |
| — | ✗ | ✗ | `0` | cold-start（无 parent、非工具续传） |

`cache_miss = max(0, 本轮 prompt_tokens - cache_hit)`。

**理由：**
- `divergence` 是 `classifyDivergence`（`chat-request.ts:103`）基于前缀链哈希精确计算的，比单纯"有无 parent"准确得多——`middle-damage` 时服务端做全量重置，实际无缓存，原方案会误判为命中
- `isToolContinuation` 时 `messagesBody = []`（`chat-request.ts:330`），只发 tool_result，服务端复用上轮完整上下文——这是**最确定的缓存命中场景**，原方案风险清单反而把它列为"可能偏高"，是误判
- `spike-full-context-injection.md` 实测印证：1.4c 复用 chat_id + parent 空 → prompt_tokens=3,785（≈首轮 3,784，无缓存）；1.5 带 parent 续传 → 4,182（高 ~400，有缓存）。证明 parent 存在性 + divergence 能准确区分"服务端复用历史"vs"当新输入"

**备选：**
- 仅看 parent_message_id 非空（原方案，粗粒度，middle-damage 误判）
- 透传上游原始 usage（上游无缓存字段，不可行）
- 本地按消息内容哈希做前缀匹配估算（`classifyDivergence` 已经做了这件事，直接复用即可）

**实现要点：** `buildRequestBody` 当前返回 `{ body, json, divergence, suffixStart }`（`chat-request.ts:420`），需额外返回 `isToolContinuation`（内部已计算于 `chat-request.ts:258`，未导出）。`requestBody.parent_message_id` 已在 body 里，直接读。`lastPromptTokens` 存储时需 guard `promptTokens > 0`，避免上游增量事件 prompt_tokens=0 污染下一轮估算。

### D2: 字段名用 DeepSeek 风格，置于 usage 顶层

**选择：** `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `cache_estimated`，平铺在 usage 对象。

**理由：** 用户明确要求 DeepSeek 风格。DeepSeek 的字段就在 usage 顶层，不嵌套。

**备选：** OpenAI 风格 `prompt_tokens_details.cached_tokens`（嵌套，与用户要求不符）。

### D3: 新增 `lastPromptTokens` Map，复用现有 TTL 清理循环

**选择：** 在 `chat-request.ts` 加 `lastPromptTokens: Map<chat_id, number>`，加入现有 `cleanupTimer` 的清理分支。

**理由：** 与 `lastResponseMessageId` 同生命周期、同清理节奏，避免新增定时器。TTL 4h 与现有 tracker 一致。

### D4: 流式 usage chunk 仅在 include_usage=true 时发

**选择：** 检查 `request.stream_options?.include_usage`，为 true 才在 `[DONE]` 前补发 `choices: []` + `usage` 的最终 chunk。

**理由：** OpenAI 协议要求 `include_usage` opt-in，不期望 usage 的客户端收到空 choices chunk 会困惑。当前流式不发 usage 是合规的，补发必须 opt-in。

**类型缺口：** `OpenAIChatCompletionRequest`（`types/openai.ts:68`）当前未声明 `stream_options` 字段。运行时 `req.body as OpenAIChatCompletionRequest`（`openai.ts:93`）不删属性，`stream_options` 会保留在对象上，但 TypeScript 编译会报错。需在类型加 `stream_options?: { include_usage?: boolean | null } | null`。

### D5: 始终填 cache_estimated: true

**选择：** 无论首轮还是续传，usage 都带 `cache_estimated: true`。

**理由：** 这是估算值而非上游真实数据，客户端需要知道这一点来决定是否信任。即使首轮 cache_hit=0 是确定的，保持标记一致更简单，客户端无需区分场景。

### D6: 类型扩展用 intersection 而非替换

**选择：**
- `OpenAIUsage = CompletionUsage & { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; cache_estimated?: boolean }`
- `OpenAIChatCompletionChunk` 扩展为 `ChatCompletionChunk & { codearts?: ...; usage?: OpenAIUsage | null }`（覆盖 usage 字段类型，让流式 chunk 支持缓存字段）
- `OpenAIChatCompletionRequest` 加 `stream_options?: { include_usage?: boolean | null } | null`

**理由：** 向后兼容，旧代码不访问新字段不受影响。字段可选，避免破坏现有 usage 构造点。`ChatCompletionChunk.usage` 原类型是 `CompletionUsage | null`，不引用 `OpenAIUsage`，需单独覆盖。`stream_options` 是 OpenAI 官方协议字段，当前类型遗漏。

## Risks / Trade-offs

- **[估算偏差：工具续传的 tool result 改写]** 客户端改写 tool result 内容时，服务端可能不缓存 → `cache_estimated: true` 标记告知客户端；工具续传的 messagesBody=[] 让服务端复用上轮上下文，仍是高置信度缓存命中
- **[估算偏差：热链分叉修复]** `CHAIN_DIVERGENCE_REPAIR_ENABLED` 开启时 `middle-damage` / `forceResync` 会全量重置 → 改进方案已正确识别为 cache_hit=0（原方案会误判）
- **[估算偏差：子代理跨代理 parent]** 子代理 chat_id 独立，但单子代理内多轮续传仍走 parent 链 → 按 divergence 判断即可，不需特殊处理
- **[估算偏差：chat_id 跳轮]** 客户端用更早的 parent，`lastPromptTokens` 只存上一轮 → 无法检测，接受误差
- **[进程重启丢失]** `lastPromptTokens` 内存态，重启后首轮续传会算 cache_hit=0 → 与 `lastResponseMessageId` 同行为，可接受
- **[流式 usage chunk 兼容性]** 某些非标准客户端可能不期望空 choices chunk → 仅 `include_usage=true` 才发，opt-in 已隔离
- **[divergence 未导出 isToolContinuation]** `buildRequestBody` 内部计算了 `isToolContinuation`（`chat-request.ts:258`）但未在返回值暴露 → 需在返回值里加 `isToolContinuation` 字段（一行改动）
