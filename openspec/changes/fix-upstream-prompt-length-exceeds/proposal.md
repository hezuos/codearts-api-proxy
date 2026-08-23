## Why

上游 CodeArts 对单次请求的累积 prompt 长度有 196608 token 硬限制。热链续传时 proxy 只发增量、历史在上游服务端累积，proxy 无法控制上游历史长度。当对话足够长（实测 243294 tokens）触发 `ChatAgent.00001216: Prompt length exceeds` 错误，直接抛给客户端，对话中断且无法自动恢复。

实验验证（`scripts/experiment-prompt-tokens-accumulation.ts` + `experiment-large-fold-reset.ts`）确认：
1. 上游返回的 `prompt_tokens` 是**累积历史总长**（含服务端拼接的 parent 历史），proxy 已通过 `getLastPromptTokens(cid)` 跟踪
2. `parent_message_id` 空 + 全量折叠注入时，上游**不叠加旧历史**（重置生效）
3. 报错后立即用 `forceResync`（parent 空 + 200K chars 折叠）重试，成功恢复（83298 tokens < 196608）

## What Changes

- **方向1：主动断链重置**——在 `buildRequestBody` 中，当 `getLastPromptTokens(cid)` 接近上游硬限制（默认阈值 180000，留 16K 余量）且当前是 `normal` 热链续传路径时，强制 `divergence = "middle-damage"` 走全量折叠重置，避免一次失败往返。流式重置前发 notice chunk `"\n[上下文已压缩：累积长度超过上游限制，已重置对话链继续。早期细节可能丢失。]\n"`；非流式在响应 metadata 标记 `codearts.context_reset = true`
- **方向2：错误后自动恢复**——在 `chat.ts` / `chat-stream.ts` 错误处理中识别 `ChatAgent.00001216` 错误码，自动 `forceResync: true` 重试一次（复用现有 tail-divergence 恢复模式）。流式重试前发 notice chunk `"\n[上下文已压缩：累积长度超过上游限制，已重置对话链继续。早期细节可能丢失。]\n"`；非流式在响应 metadata 标记 `codearts.error_recovery = "ChatAgent.00001216"`
- 新增配置项 `UPSTREAM_PROMPT_TOKEN_LIMIT`（默认 196608，上游硬限制）和 `UPSTREAM_PROMPT_TOKEN_RESET_THRESHOLD`（默认 180000，主动重置阈值）
- 扩展 `OpenAICodeArtsResponseMetadata` 加 `context_reset?: boolean` 和 `error_recovery?: string` 字段
- `FULL_CONTEXT_MAX_CHARS_BY_MODEL` 建议配置 `{"GLM-5.2": 400000}`（实测 400K chars ≈ 167K tokens + 基础开销 ~3K = 170K < 196608，安全）
- **范围扩大**：本 change 同时改造所有静默处理路径为可见，统一抽取 `emitNoticeChunk` 辅助函数（`src/upstream/huawei/chat-notice.ts`）。改造 tail-divergence resync、forceResync/折叠等静默路径。PROTOCOL_ERROR 保持静默（畸形 SSE 行跳过是正确行为）

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `openai-api`: chat completions 请求在累积 prompt_tokens 接近上游限制时主动重置热链；上游返回 `ChatAgent.00001216` 时自动 forceResync 重试一次而非直接抛错；所有静默处理路径（tail-divergence resync、context folding）改为可见，统一发 notice chunk（流式）或 metadata 标记（非流式）

## Impact

- **代码**：`src/config.ts`（新增 2 个配置项）、`src/types/openai-codearts.ts`（扩展 metadata 类型加 `context_reset`/`error_recovery`）、`src/upstream/huawei/chat-notice.ts`（**新文件**，统一 `emitNoticeChunk`/`buildNoticeMetadata` 辅助函数）、`src/upstream/huawei/chat-request.ts`（`buildRequestBody` 加阈值检查 + 返回 `proactiveReset` 标志）、`src/upstream/huawei/chat.ts`（错误处理识别 00001216 + forceResync 重试 + metadata 标记 + tail-divergence resync 可见化）、`src/upstream/huawei/chat-stream.ts`（流式错误处理识别 00001216 + notice chunk + forceResync 重试 + tail-divergence resync 可见化 + 折叠可见化）、`src/upstream/huawei/chat-recovery.ts`（重构复用 `emitNoticeChunk`）
- **API**：响应 metadata 新增 `codearts.context_reset` 和 `codearts.error_recovery` 字段（可选，向后兼容）；流式重置/恢复/折叠时多一段 notice 文本 chunk
- **行为**：接近上游限制时对话会"压缩"——历史折叠成摘要后重新开始，细节丢失但对话不中断。客户端可见提示：流式主动重置/00001216 恢复/tail-divergence resync/折叠均发 notice chunk；非流式在响应 metadata 标记 `context_reset`/`error_recovery`（客户端可选择性展示）。PROTOCOL_ERROR 保持静默
- **配置**：生产环境建议设置 `FULL_CONTEXT_MAX_CHARS_BY_MODEL={"GLM-5.2":400000}` 确保重置后折叠上下文足够且不超限
- **依赖**：无新增依赖
