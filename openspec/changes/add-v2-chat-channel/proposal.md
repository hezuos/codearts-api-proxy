## Why

上游 CodeArts 新增了 `glm-5.3` 模型，但代理当前使用的 `/v1/chat/chat`（CodeArts 原生协议）通道不支持该模型——实测返回 `ChatAgent.00001216`（内层 `ChatAgent.00001007`），而 `/v1/models` 能正常列出 `glm-5.3`，说明问题出在 chat 通道而非模型列表或鉴权。

IDE 自身走的是 `${chatDomain}/api/v2/chat/completions`（OpenAI 兼容协议）。实测该通道使用与 `/v1/chat/chat` 完全相同的 AK/SK 签名与 header 集合即可访问，`glm-5.3`、`GLM-5.2`、`deepseek-v4.1-flash` 均返回 HTTP 200 且带 `reasoning_content`（thinking 能力默认开启）。

因此需要把代理的模型请求统一切换到 v2 通道，以支持 `glm-5.3` 及其 thinking 能力。

## What Changes

- 新增 v2 通道端点配置（`HUAWEI_V2_CHAT_PATH`，默认 `/api/v2/chat/completions`）。
- 新增 v2 请求体构造：OpenAI 请求 → `{model, max_tokens, tool_stream, stream, messages, tools?}`。
- 新增 v2 SSE 解析分支：标准 OpenAI `choices[].delta` 格式（与 CodeArts 原生 `delta` 格式不同），复用 `reasoning_content` 映射。
- 非流式路径同步改造为 v2。
- **BREAKING**：所有模型请求统一走 v2 通道，不再使用 `/v1/chat/chat`。
- 处理 v2 通道下 CodeArts 专有能力的替代方案：
  - `tool_result` 续传 → 标准 `role: "tool"` 消息
  - `parent_message_id` 链续传 → v2 无此字段，需重新设计续传/链指纹策略
  - `sub_agent` → 评估 v2 是否支持，不支持则降级为普通消息
- 调整链指纹策略，处理 `reasoning_content` 导致的 `lastReplyHash` 失配风险。

## Capabilities

### New Capabilities

- `v2-chat-channel`: 通过 `/api/v2/chat/completions`（OpenAI 兼容协议）与上游 CodeArts 通信，支持 `glm-5.3` 等新模型及其 thinking 能力。

### Modified Capabilities

- `codearts-request-forwarding`: 上游请求构造从 CodeArts 原生协议改为 OpenAI 兼容协议，请求体字段与续传机制随之变化。
- `sse-streaming`: 上游 SSE 事件格式从 CodeArts 原生 `delta` 改为标准 OpenAI `choices[].delta`，解析与映射逻辑需适配。
- `chain-divergence-detection`: v2 通道无 `parent_message_id`，链续传与分叉检测的判定依据需重新设计。
- `tool-passthrough`: 工具续传从 `task_parameters.tool_result` 改为标准 `role: "tool"` 消息。

## Impact

- 受影响代码：`src/config.ts`、`src/upstream/huawei/chat-request.ts`、`src/upstream/huawei/chat-stream.ts`、`src/upstream/huawei/chat.ts`、`src/upstream/huawei/chat-protocol.ts`、`src/upstream/huawei/chat-translate.ts`、`src/upstream/huawei/chat-recovery.ts`。
- 受影响配置：`.env.example` 新增 v2 端点配置项。
- 受影响测试：`chat-request-context.test.ts`、`chat.test.ts`、`chat-translate.test.ts`、`stream-recovery.test.ts`、`error-recovery.test.ts`、`proactive-reset.test.ts`、`cache-usage.test.ts` 等。
- 风险：v2 通道可能不支持 `sub_agent`、`parent_message_id`、`tool_result` 续传等 CodeArts 专有能力，需实测确认并设计降级方案。
- 鉴权无变化：v2 与 v1 使用相同的 AK/SK 签名与 header 集合。