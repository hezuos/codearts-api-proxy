## Context

上游 CodeArts 对单次请求的累积 prompt 长度有 196608 token 硬限制。热链续传路径（`divergence = "normal"`）下 proxy 只发增量、历史在上游服务端累积，proxy 无法控制上游历史长度。当累积超过限制时上游返回 `ChatAgent.00001216: Prompt length exceeds`，对话中断。

实验验证（`scripts/experiment-prompt-tokens-accumulation.ts` + `experiment-large-fold-reset.ts`）：
- `prompt_tokens` 是累积历史总长，proxy 已通过 `getLastPromptTokens(cid)` 跟踪
- `parent_message_id` 空 + 全量折叠注入时上游不叠加旧历史（重置生效）
- 报错后立即 `forceResync`（parent 空 + 200K chars 折叠）重试成功（83298 tokens < 196608）
- chars/tokens ratio ~2.2-2.4（中文），400K chars ≈ 167K tokens + 基础开销 ~3K = 170K < 196608（安全）

## Goals / Non-Goals

**Goals:**
- 防止 `ChatAgent.00001216` 错误中断对话
- 对客户端可见：重置/重试时发 notice chunk（流式）或 metadata 标记（非流式），让用户知道发生了什么
- 复用现有 `forceResync` / `foldFullConversation` 机制，最小改动
- 统一抽取 `emitNoticeChunk` 辅助函数，改造所有静默处理路径为可见

**Non-Goals:**
- 不改变 `foldFullConversation` 的折叠算法（仅调整触发时机）
- 不改变 `FULL_CONTEXT_MAX_CHARS` 默认值（仅文档建议生产配置）
- 不做客户端侧历史截断（方向3，本次不做）
- 不改造 PROTOCOL_ERROR 静默跳过（畸形 SSE 行跳过是正确行为，发提示反而干扰）

## Decisions

### D1: 主动重置触发点放在 `buildRequestBody` 内

**决策**：在 `buildRequestBody`（`chat-request.ts:312`）的 divergence 分类之后、messagesBody 构造之前，加阈值检查。当 `divergence === "normal"` && `parentMessageId` 非空 && `!isToolContinuation` && `getLastPromptTokens(chatId) > config.upstreamPromptTokenResetThreshold` 时，强制 `divergence = "middle-damage"` + `parentMessageId = ""`。

**理由**：
- `buildRequestBody` 是所有请求路径的统一入口，在此修改一次即可覆盖 streaming 和 non-streaming
- 复用现有 `divergence === "middle-damage"` 分支（L391-398）的 `foldFullConversation` 逻辑，无需新增折叠代码
- 在 divergence 分类之后插入，不影响 `classifyDivergence` 的正常工作
- `isToolContinuation` 排除：tool continuation 发空 messagesBody 依赖 parent，重置会破坏工具流

**替代方案（否决）**：在 `chat.ts` / `chat-stream.ts` 调用 `buildRequestBody` 前检查——需要两处重复代码，且 `buildRequestBody` 内部已有 `forceResync` 选项的类似模式（L375-377），保持一致。

### D2: 错误恢复复用 tail-divergence 重试模式

**决策**：在 `chat.ts` L84-96（HTTP 错误）和 L118-134（SSE 错误）的现有 tail-divergence 重试条件中，扩展识别 `ChatAgent.00001216`。在 `chat-stream.ts` L250-273 的 tail-divergence repair fallback 中，同样扩展识别 00001216。

**理由**：
- 现有模式已是 `if (divergence === "tail-divergence" && !options.forceResync) { retry with forceResync }`
- 扩展为 `if ((divergence === "tail-divergence" || errorCode === "ChatAgent.00001216") && !options.forceResync)`
- `!options.forceResync` 守卫已防止无限重试（第二次 forceResync=true 时条件不满足）
- chat-stream.ts 的 `resyncRetried` 标志同样防止无限重试

**注意**：00001216 可能在任何 divergence 路径触发（不只是 tail-divergence），所以条件用 `||` 而非替换。实验轮5 显示 600K chars 折叠（middle-damage 路径）也会触发 00001216。

### D3: 配置项命名与默认值

**决策**：
- `UPSTREAM_PROMPT_TOKEN_LIMIT`（默认 196608）：上游硬限制，仅用于日志/文档，不直接参与逻辑
- `UPSTREAM_PROMPT_TOKEN_RESET_THRESHOLD`（默认 180000）：主动重置阈值，留 16K 余量给生成 + 基础开销

**理由**：
- 180000 = 196608 - 16608，16K 余量覆盖：基础开销 ~3K + 单轮增量 ~1K + 生成预留 ~12K
- 实验轮3（200K chars 折叠）= 83298 tokens，轮4 续传 = 103684 tokens（+20386），说明单轮增量可能很大（折叠文本成了历史）。但主动重置后下一轮是 cold-start（parent 空），不会立即续传大增量
- 阈值可配置：不同模型有不同限制（如 openpangu-2.0-flash ~9K），用户可调低

### D4: `FULL_CONTEXT_MAX_CHARS_BY_MODEL` 生产建议

**决策**：文档建议 `{"GLM-5.2": 400000}`，不改默认值（默认 8000 保守）。

**理由**：
- 实测 400K chars ≈ 167K tokens + 基础开销 ~3K = 170K < 196608（安全）
- 500K chars ≈ 215K tokens > 196608（超限，实验轮5 验证）
- 默认 8000 太小：重置后折叠上下文只有 ~3K tokens，模型几乎"失忆"
- 不改默认值：避免影响未配置的用户；通过文档引导生产环境配置

### D5: 不在 `classifyDivergence` 中加阈值检查

**决策**：阈值检查放在 `buildRequestBody` 主流程，不放进 `classifyDivergence` 函数。

**理由**：
- `classifyDivergence` 的职责是对比 client 发来的 messages 与 chainState 判断链路损伤，与上游 token 限制无关
- `getLastPromptTokens` 是上游返回值的跟踪，`classifyDivergence` 的输入是 client 侧 messages，两者数据源不同
- 保持 `classifyDivergence` 纯函数特性，便于测试

### D6: 可见性策略——流式发 notice chunk + metadata 标记，非流式仅 metadata 标记

**决策**：
- **流式主动重置（能力1）**：proxy 检测超阈值后，**先向 client 流式发 notice chunk**（content = `"\n[上下文已压缩：累积长度超过上游限制，已重置对话链继续。早期细节可能丢失。]\n"`），**然后才调上游**（带 forceResync 的折叠请求），上游响应继续流式转发。client 看到的是：notice 文本 + 正常响应
- **非流式主动重置（能力1）**：无法中途插入 notice（一次性返回），在响应 `codearts.context_reset = true` 标记
- **流式 00001216 恢复（能力2）**：在 resync 重试前发 notice chunk（同上内容），复用现有限流重试的 `noticeChunk` 模式（chat-stream.ts L200-219）
- **非流式 00001216 恢复（能力2）**：不发 notice，在响应 `codearts.error_recovery = "ChatAgent.00001216"` 标记
- 扩展 `OpenAICodeArtsResponseMetadata` 加 `context_reset?: boolean` 和 `error_recovery?: string` 字段

**理由**：
- **关键修正**：流式主动重置 CAN 发 notice chunk——proxy 在调上游前先写一个 chunk 到 `res`，SSE 允许随时写 chunk。之前说"流式还没开始"是错的，`res` 已可用（请求已进入流式 handler）
- 这比两阶段 tool_call 方案更简单：不需要 client 识别自定义 `context_reset` 工具（opencode 不知道这个工具，无法执行）
- 非流式无法中途插入提示，metadata 标记让客户端可选择性展示
- 复用现有 `noticeChunk` 模式（限流重试已用），保持代码一致性

**否决的替代方案**：两阶段 tool_call（阶段1 返回 synthetic `context_reset` tool_call，阶段2 client 回调触发真正重置）——要求 client 能执行 proxy 自定义的 `context_reset` 工具，但 opencode 只执行 LLM 返回的 tool_calls 且 `context_reset` 不在 client 工具列表里，不可行

### D7: 本 change 改造所有静默处理路径的可见性

**决策**：本 change 把以下静默路径全部改造成可见，并统一抽取一个 `emitNoticeChunk` 辅助函数：
- tail-divergence resync 重试（chat.ts #1/#3, chat-stream.ts #5）
- forceResync / middle-damage / duplicate-stale 折叠（chat-request.ts #10/#11）
- 主动重置（本 change 新增）
- 00001216 恢复（本 change 新增）

**保持静默的**：PROTOCOL_ERROR 跳过（#2/#4/#9）——畸形 SSE 行跳过是正确的，发提示反而干扰用户。

### D8: 统一抽取 `emitNoticeChunk` 辅助函数

**决策**：在 `src/upstream/huawei/chat-notice.ts`（新文件）抽取统一辅助函数：

```ts
/**
 * 流式：向 client 发一个 notice chunk（可见提示）。
 * 复用现有 noticeChunk 构造模式（chat-stream.ts L200-219）。
 */
export function emitNoticeChunk(params: {
  res: ServerResponse;
  completionId: string;
  created: number;
  model: string;
  content: string;          // notice 文本
  responseMetadata: Record<string, string | undefined>;
  extraMetadata?: Record<string, unknown>;  // 如 { context_reset: true } / { error_recovery: "..." }
  sentRole: boolean;
  sentMetadata: boolean;
}): { sentRole: boolean; sentMetadata: boolean };

/**
 * 非流式：无法发 notice chunk，返回要合并到响应 metadata 的标记。
 */
export function buildNoticeMetadata(params: {
  reason: string;           // 如 "tail-divergence-resync" / "context-reset" / "ChatAgent.00001216"
  extra?: Record<string, unknown>;
}): Record<string, unknown>;  // 如 { error_recovery: "tail-divergence-resync" }
```

**notice 文本模板**（统一格式 `\n[<标题>：<详情>]\n`）：
- 主动重置：`"\n[上下文已压缩：累积长度超过上游限制，已重置对话链继续。早期细节可能丢失。]\n"`
- 00001216 恢复：`"\n[上下文已压缩：累积长度超过上游限制，已重置对话链继续。早期细节可能丢失。]\n"`
- tail-divergence resync：`"\n[上下文链分叉：检测到尾部不一致，已切换全量重置继续。]\n"`
- forceResync/折叠：`"\n[上下文已重置：对话链已折叠重建。]\n"`

**理由**：
- 现有 noticeChunk 构造在 chat-stream.ts L200-219 内联，重复出现在限流重试、recovery 等处
- 抽取后所有路径复用同一函数，保证格式一致、metadata 标记一致
- 非流式无法发 chunk，`buildNoticeMetadata` 返回 metadata 标记让 client 可选展示
- PROTOCOL_ERROR 不纳入（跳过畸形行是正确行为，无需提示）

**改造范围**：
| 路径 | 当前 | 改造后 |
|------|------|--------|
| chat.ts #1 HTTP tail-divergence resync | 静默递归 | 递归 + 响应 metadata `error_recovery="tail-divergence-resync"` |
| chat.ts #3 SSE tail-divergence resync | 静默递归 | 递归 + 响应 metadata `error_recovery="tail-divergence-resync"` |
| chat-stream.ts #5 tail-divergence resync | 静默切换流 | `emitNoticeChunk` + 切换流 |
| chat-request.ts #10 forceResync | 静默折叠 | 由调用方（chat.ts/chat-stream.ts）在重试后标记 metadata |
| chat-request.ts #11 middle-damage/duplicate-stale | 静默折叠 | 由 `buildRequestBody` 返回 `divergence` 标志，调用方发 notice/metadata |
| 主动重置（新增） | N/A | 流式 `emitNoticeChunk` + 非流式 metadata |
| 00001216 恢复（新增） | N/A | 流式 `emitNoticeChunk` + 非流式 metadata |

## Risks / Trade-offs

| 风险 | 缓解 |
|------|------|
| 主动重置后模型"忘记"早期细节 | 折叠摘要保留关键信息；`FULL_CONTEXT_MAX_CHARS` 越大保留越多（但受上游限制） |
| 阈值 180000 对小模型太高 | `UPSTREAM_PROMPT_TOKEN_RESET_THRESHOLD` 可配置；文档建议按模型调整 |
| forceResync 重试也失败（折叠文本本身超限） | `!options.forceResync` 守卫防止无限重试；重试失败后正常抛错，错误信息提示操作员调小 `FULL_CONTEXT_MAX_CHARS_BY_MODEL` |
| 00001216 在 streaming 中途触发 | chat-stream.ts L250-273 已有 resync 重试模式，重试后继续写 res 流，客户端看到连续流 |
| `getLastPromptTokens` 可能未初始化（首次请求） | 返回 undefined，`undefined > threshold` 为 false，不触发重置——安全 |

## Migration

- 向后兼容：新增配置项有默认值，不配置也能工作
- 行为变化：接近上游限制时对话会"压缩"——客户端可能注意到模型"忘记"早期细节。这是预期行为，比对话中断更好
- 生产环境建议设置 `FULL_CONTEXT_MAX_CHARS_BY_MODEL={"GLM-5.2":400000}` 确保重置后折叠上下文足够
