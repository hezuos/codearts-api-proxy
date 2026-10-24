# Changelog

## [Unreleased]

### Added
- 上游并发闸门：按 `providerAccountId` FIFO 排队（`UPSTREAM_MAX_CONCURRENCY`，默认 3），并对 HTTP 400 / `TM.00001041`（并发会话数已达上限）做指数退避重试；超限时向客户端返回 429 + `Retry-After`。
- 撞限自适应：3 个槽位是账号级共享的（官方 IDE / 其他客户端同样占用），代理观察不到外部在途数。因此撞限时将该账号的有效并发上限逐级下调（最低 `UPSTREAM_MIN_CONCURRENCY`），连续 `UPSTREAM_CONCURRENCY_RECOVER_MS` 无撞限后逐级恢复。
- 上游流被放弃（重试/中断）时立即 `destroy()` 连接，释放上游会话槽位。

### Fixed
- 上游响应只发 `close`（不发 `end`/`error`）时，SSE 迭代器会永久挂起，导致闸门槽位泄漏且客户端请求悬挂；现监听 `close` 并唤醒等待者。

### Changed
- 移除 v1（CodeArts 原生 `/v1/chat/chat`）请求构造及其折叠/注入逻辑；v2 仅全量透传客户端 messages。
- 移除 `FULL_CONTEXT_INJECTION_ENABLED`、`MISSING_CONTEXT_HINT`，以及 `codearts.parent_message_id` / `codearts.tool_results` 等 v1 输入字段。
- 上下文超限（`ChatAgent.00001216` / HTTP 413）改为返回 OpenAI 兼容错误 `context_length_exceeded`（HTTP 400），由客户端自行压缩；不再重试或改写历史。

### Removed
- **BREAKING** 移除折叠与截断机制：历史一律逐字透传，不再改写、压缩或丢弃消息。
- **BREAKING** 移除 `forceResync` 合成工具调用（含让客户端执行 `echo codearts::forceResync` 的假调用）及其注册表、检测与毒离逻辑。
- **BREAKING** 移除主动重置（基于累计 token 阈值触发压缩）与相关提示消息。
- **BREAKING** 移除链分叉修复与全量重置重试，分叉仅用于日志与缓存估算。
- **BREAKING** 删除环境变量 `FULL_CONTEXT_MAX_CHARS`、`FULL_CONTEXT_MAX_CHARS_BY_MODEL`、`UPSTREAM_PROMPT_TOKEN_RESET_THRESHOLD`、`CHAIN_DIVERGENCE_REPAIR_ENABLED`。
- 使用侧需同步：把客户端声明的模型窗口调到接近上游真实上限（约 18 万 token），由客户端负责上下文管理。

## [2.4.3] - 2026-10-23

### Fixed
- 非流式响应的 `tool_calls` 被拆成多个调用（`name` 为 `unknown`、参数碎片化）：v2 上游即使 `stream=false` 仍以 SSE 分片下发工具调用，现按 `index` 累加合并后再返回。

### Security
- 修复 6 个 Dependabot 依赖漏洞（`pnpm-workspace.yaml` overrides 强制提升传递依赖至补丁版本）：`proxy-addr` ^2.0.8（critical，runtime）、`brace-expansion` ^5.0.10（high，dev）、`ip-address` ^10.7.1（medium ×2，runtime）、`qs` ^6.16.0（medium ×2，runtime）。

## [2.4.2] - 2026-10-23

### Fixed
- 修正 middle-damage 场景测试断言（语义反转为「静默」）与 T17 旁路透传消息数断言。

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
