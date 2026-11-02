## Purpose

通过上游 CodeArts 的 `/api/v2/chat/completions`（OpenAI 兼容协议）通道转发模型请求，使代理能够使用 `glm-5.3` 等仅在 v2 通道可用的模型，并默认获得其 thinking（`reasoning_content`）能力。

## ADDED Requirements

### Requirement: v2 通道端点可配置

代理 SHALL 通过可配置的端点路径访问上游 v2 通道，默认路径为 `/api/v2/chat/completions`，并拼接在 `HUAWEI_CHAT_HOST` 之后。

#### Scenario: 使用默认端点

- **WHEN** 未设置 v2 端点路径环境变量
- **THEN** 代理 SHALL 使用 `${HUAWEI_CHAT_HOST}/api/v2/chat/completions` 作为上游 chat 端点

#### Scenario: 覆盖端点路径

- **GIVEN** 环境变量设置了自定义 v2 端点路径
- **WHEN** 代理构造上游请求
- **THEN** 代理 SHALL 使用该自定义路径拼接 `HUAWEI_CHAT_HOST`

### Requirement: v2 请求体为 OpenAI 兼容格式

代理 SHALL 将客户端的 OpenAI 请求转换为 v2 通道要求的请求体，包含 `model`、`max_tokens`、`tool_stream`、`stream` 与 `messages` 字段；当客户端提供工具定义时 SHALL 一并携带 `tools`；当请求为子代理请求时 SHALL 携带 `isSubAgent`、`subAgent_type` 与 `subAgent_prompt`。

#### Scenario: 流式请求体构造

- **GIVEN** 客户端发送 `stream: true` 的 chat 请求
- **WHEN** 代理构造 v2 请求体
- **THEN** 请求体 SHALL 包含 `stream: true`
- **AND** 请求体 SHALL 包含 `tool_stream: true`
- **AND** 请求体 SHALL 包含 `model` 为解析后的上游模型标识
- **AND** 请求体 SHALL 包含 `messages` 数组

#### Scenario: 非流式请求体构造

- **GIVEN** 客户端发送 `stream: false` 的 chat 请求
- **WHEN** 代理构造 v2 请求体
- **THEN** 请求体 SHALL 包含 `stream: false`
- **AND** 请求体 SHALL NOT 依赖 CodeArts 原生字段（`chat_id`、`task_parameters`、`parent_message_id`、`is_delta_response`）

#### Scenario: 携带工具定义

- **GIVEN** 客户端请求包含非空 `tools` 数组
- **WHEN** 代理构造 v2 请求体
- **THEN** 请求体 SHALL 包含转换后的 `tools` 数组

#### Scenario: 子代理字段透传

- **GIVEN** 客户端请求包含 `codearts.sub_agent`
- **WHEN** 代理构造 v2 请求体
- **THEN** 请求体 SHALL 包含 `isSubAgent: true`
- **AND** 请求体 SHALL 包含 `subAgent_type` 与 `subAgent_prompt`
- **AND** 请求体 SHALL 仅携带缩减后的子代理工具集

#### Scenario: max_tokens 默认值与上限

- **GIVEN** 客户端未指定 `max_tokens`
- **WHEN** 代理构造 v2 请求体
- **THEN** 请求体 SHALL 使用默认值 65536（64k）
- **AND** 当客户端指定的 `max_tokens` 超过 65536 时，代理 SHALL 将其 clamp 到 65536
- **AND** 该上限为上游实测值（65536 成功、65537 起返回 `InferHub.001001005.400`）

### Requirement: v2 通道鉴权与 v1 一致

代理 SHALL 对 v2 通道请求使用与 `/v1/chat/chat` 相同的 AK/SK 签名流程与相同的额外请求头集合。

#### Scenario: 签名请求

- **WHEN** 代理向 v2 端点发起请求
- **THEN** 代理 SHALL 使用 `signRequest` 对请求进行 AK/SK 签名
- **AND** 代理 SHALL 携带与 v1 通道相同的额外头（含 `Agent-Type: ChatAgent`、`x-snap-traceid`、`client_version`、`plugin-name`、`plugin-version`、`ide-name`、`ide-version`、`is_confidential`、`heartbeat-enable`）

### Requirement: v2 通道支持 glm-5.3 与 thinking 能力

代理 SHALL 能够通过 v2 通道请求 `glm-5.3` 模型，并将上游返回的 `reasoning_content` 透传给客户端。

#### Scenario: glm-5.3 请求成功

- **GIVEN** 客户端请求 `model: "glm-5.3"`
- **WHEN** 代理通过 v2 通道发起请求
- **THEN** 上游 SHALL 返回 HTTP 200
- **AND** 代理 SHALL NOT 返回 `ChatAgent.00001216` 或 `ChatAgent.00001007` 错误

#### Scenario: thinking 内容透传

- **GIVEN** 上游 v2 流式响应包含 `choices[].delta.reasoning_content`
- **WHEN** 代理处理该事件
- **THEN** 代理 SHALL 在发给客户端的 delta 中保留 `reasoning_content` 字段

### Requirement: v2 通道错误可观测

代理 SHALL 在 v2 通道返回非 200 状态或流内错误时记录错误码与错误信息，并向客户端返回可识别的错误。

#### Scenario: 上游返回非 200

- **WHEN** v2 端点返回非 200 状态码
- **THEN** 代理 SHALL 记录状态码与响应体（截断）
- **AND** 当状态码为 401 或 403 时 SHALL 抛出上游鉴权错误以触发凭证刷新

#### Scenario: 流内错误事件

- **GIVEN** v2 流式响应中出现错误事件
- **WHEN** 代理解析该事件
- **THEN** 代理 SHALL 记录错误码与错误信息
- **AND** 代理 SHALL 向客户端发送错误 chunk 后关闭流

### Requirement: v2 通道 usage 透传

代理 SHALL 透传上游 v2 通道返回的 `usage` 字段，并在上游提供 `prompt_tokens_details` 时使用真实缓存用量值。

#### Scenario: 上游返回 usage

- **GIVEN** 上游 v2 响应包含 `usage` 字段
- **WHEN** 代理处理该响应
- **THEN** 代理 SHALL 在发给客户端的响应中保留 `prompt_tokens` 与 `completion_tokens`
- **AND** 当上游提供 `prompt_tokens_details` 时，代理 SHALL 使用其真实值而非估算值

#### Scenario: 上游未返回 usage

- **GIVEN** 上游 v2 响应未包含 `usage` 字段
- **WHEN** 代理处理该响应
- **THEN** 代理 SHALL 回退到基于 divergence 的缓存用量估算