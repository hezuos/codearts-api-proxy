# Changelog

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
