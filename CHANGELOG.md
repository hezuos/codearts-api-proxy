# Changelog

## [2.4.1] - 2026-10-23

### Changed
- **BREAKING**: 上游 chat 通道从 CodeArts 原生 `/v1/chat/chat` 统一切换到 OpenAI 兼容的 `/api/v2/chat/completions`（`HUAWEI_V2_CHAT_PATH` 可配置）。
  - 新增 `glm-5.3` 支持（v1 通道对该模型返回 `ChatAgent.00001216` / `00001007`）。
  - v2 默认返回 `reasoning_content`（thinking 能力默认开启），代理透传给客户端。
  - 请求体改为 OpenAI 兼容形状：`{model, max_tokens, tool_stream, stream, messages, tools?}`；`max_tokens` 默认 65536（64k，上游实测上限），并对客户端传入值做 clamp。
  - 工具续传从 `task_parameters.tool_result` 改为标准 `role: "tool"` 消息（`[assistant(tool_calls), tool(result)]`）。
  - 子代理字段（`isSubAgent` / `subAgent_type` / `subAgent_prompt`）直接透传，不再降级。
  - v2 无 `parent_message_id`，续传判定完全依赖链状态（`chainStates`）与客户端回传历史。
  - 链指纹（`normalizeForChain`）移除 `reasoning_content`，避免客户端不回传 reasoning 时误判 divergence。
  - 缓存用量优先使用上游真实 `usage.prompt_tokens_details`，未返回时回退到 divergence 估算。
  - **messages 全量透传**：实测 v2 上游无服务端会话状态（增量请求丢失上下文），每个请求全量透传客户端原生消息数组（保留 role / tool_calls 结构，token 效率最优）；折叠仅作逃生通道（forceResync 恢复重试 / 主动重置 / 超出字符预算）。

### Added
- 配置项 `HUAWEI_V2_CHAT_PATH`（默认 `/api/v2/chat/completions`）与 `getChatUrl()` 辅助函数。
- `buildV2RequestBody()`：v2 请求体构造（默认全量透传；forceResync / 主动重置 / 超预算时折叠为压缩单条文本）。
- `parseSSE` 支持 v2 OpenAI 兼容 `choices[].delta` 形状归一化。
- 测试 `src/upstream/huawei/chat-v2-request.test.ts`：16 个用例覆盖 v2 请求体各场景。

### Fixed
- 非流式请求返回空内容：v2 上游请求恒 `stream: true`（客户端 `stream: false` 时上游返回普通 JSON、SSE 解析为空），非流式响应由聚合路径处理。
- v2 链状态永不更新：v2 事件不含 `chat_id` / `response_message_id`，现将 chunk `id` 映射为 `response_message_id`，并以构建侧派生的 `chatId` 维护链状态与 prompt_tokens 追踪（客户端 `codearts` 元数据不再为空）。

## [2.2.5] - 2026-08-23

### Fixed
- 上游 `ChatAgent.00001216`（prompt length exceeds 196608）错误：新增主动重置 + 自动恢复机制。
  - **主动重置**：当累积 `prompt_tokens` 超过 `UPSTREAM_PROMPT_TOKEN_RESET_THRESHOLD`（默认 180000）时，热链续传自动全量折叠重置，避免触及硬限制。
  - **自动恢复**：HTTP/SSE 收到 `ChatAgent.00001216` 时，自动 `forceResync` 重试一次（不无限重试）。
  - **客户端可见**：流式响应在重置/恢复前发送 notice chunk（`[上下文已压缩...]` / `[上下文已重置...]`）；非流式响应在 `codearts` metadata 标记 `context_reset` / `error_recovery`。
  - tail-divergence resync 路径也增加 notice chunk（原为静默）。

### Added
- 配置项 `UPSTREAM_PROMPT_TOKEN_LIMIT`（默认 196608）、`UPSTREAM_PROMPT_TOKEN_RESET_THRESHOLD`（默认 180000）。
- `OpenAICodeArtsResponseMetadata` 新增 `context_reset`、`error_recovery` 字段。
- 测试 `src/upstream/huawei/proactive-reset.test.ts`：10 个用例覆盖主动重置触发/跳过/边界条件。

### Changed
- `buildRequestBody` 返回值新增 `proactiveReset: boolean` 标志。
- `chat.ts` HTTP/SSE 错误处理扩展 00001216 检测。
- `chat-stream.ts` 新增 00001216 流式恢复 + tail-divergence notice chunk + folding/proactive notice chunk。

## [2.2.4] - 2026-08-22

- Cache token field position fix.
