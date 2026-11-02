## Context

见 `proposal.md` - Why。当前代理的上游 chat 通道固定为 `${config.huaweiChatHost}/v1/chat/chat`，请求体为 CodeArts 原生格式（`chat_id` / `messages` / `task_parameters` / `parent_message_id` / `is_delta_response` / `model_id`），SSE 事件为 CodeArts 原生 `delta` 形状。该通道不支持 `glm-5.3`。

已实测确认（`scripts/probe-v2-channel.ts`）：

- v2 端点 `${config.huaweiChatHost}/api/v2/chat/completions` 可用，`glm-5.3` / `GLM-5.2` / `deepseek-v4.1-flash` 均返回 HTTP 200。
- 鉴权与 v1 完全一致：同一套 `signRequest` AK/SK 签名 + 同一组额外头（`Agent-Type: ChatAgent` 等）。
- 请求体为 OpenAI 兼容格式：`{model, max_tokens, tool_stream, stream, messages}`。
- 响应为 OpenAI 兼容 SSE：`data:{"id":...,"object":"chat.completion.chunk","model":"glm-5.3","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"..."}}],...}`。
- `reasoning_content` 默认返回（thinking 能力默认开启）。

现有代码结构约束：

- `chat-request.ts` 负责请求体构造（`buildRequestBody`）、header 构造（`buildChatHeaders`）、HTTP 传输（`httpsPost`）、链状态（`chainStates`）、`parent_message_id` 追踪（`lastResponseMessageId`）、prompt_tokens 追踪。
- `chat-stream.ts` 负责流式：`streamHuaweiChatToResponse`，内含 SSE 消费循环、错误恢复（00001216 / tail-divergence / 限流重试）、链状态重建。
- `chat.ts` 负责非流式：`sendHuaweiChatRequest`，同样消费 SSE 后聚合。
- `chat-protocol.ts` 的 `parseSSE` 产出 `CodeArtsSSEEvent`。
- `chat-translate.ts` 提供 `normalizeForChain` / `computeChainForMessages` / `foldFullConversation` / `extractToolResults` / `resolveTools`。
- `chat-recovery.ts` 提供 forceResync 合成 tool_call 与恢复逻辑。

## Goals / Non-Goals

**Goals:**

- 所有模型请求统一走 v2 通道，`glm-5.3` 可用且 thinking 能力默认开启。
- 保持对客户端暴露的 OpenAI 兼容接口不变（`/v1/chat/completions`、`/v1/models`）。
- 保持多轮续传、工具续传、上下文折叠、错误恢复等既有能力在 v2 通道下可用。
- 鉴权、限流、凭证刷新路径零改动。

**Non-Goals:**

- 不保留 v1 通道作为回退（用户明确要求"都走 v2"）。
- 不修改 `sign.ts`。
- 不引入新的持久化状态（链状态仍为内存态）。
- 不改变客户端可见的请求/响应契约（除 `reasoning_content` 现在会实际出现）。

## Decisions

### D1: 端点配置化，默认 v2 路径

在 `src/config.ts` 新增 `huaweiV2ChatPath`（env `HUAWEI_V2_CHAT_PATH`，默认 `/api/v2/chat/completions`），并新增 `getChatUrl()` 辅助函数返回 `${config.huaweiChatHost}${config.huaweiV2ChatPath}`。

**理由**：路径可能随上游版本变化，配置化便于热修；同时避免在 `chat-stream.ts` / `chat.ts` 两处硬编码。

**备选**：直接硬编码 v2 路径。否决——与项目"端点可配置"的既有约定（`HUAWEI_CHAT_HOST` / `HUAWEI_GPTS_URL`）不一致。

### D2: 新增 `buildV2RequestBody()`，与 `buildRequestBody()` 并存

在 `chat-request.ts` 新增 `buildV2RequestBody(request, session, options)`，返回 `{ body, json, divergence?, suffixStart?, isToolContinuation, proactiveReset }`（与 `buildRequestBody` 同签名，便于调用方切换）。

请求体构造规则：

```
{
  model: resolveModelId(request),        // 不再做 MODEL_MAP 大写映射，直接透传客户端 model
  max_tokens: Math.min(request.max_tokens ?? 65536, 65536),  // 默认 64k，上游实测上限
  tool_stream: true,
  stream: !!request.stream,
  messages: <OpenAI messages 数组>,
  ...(tools.length ? { tools } : {}),
  ...(subAgent ? { isSubAgent: true, subAgent_type, subAgent_prompt } : {})
}
```

`messages` 构造规则（关键差异点）：

| 场景 | v1 原生行为 | v2 行为 |
|------|------------|---------|
| 冷启动 / 无链 | 折叠为单条 `{type:"text", content}` | 折叠为单条 `{role:"user", content}` |
| 热链续传（normal） | `messages: []` + `parent_message_id` | 仅发送最新 user turn（`{role:"user", content}`） |
| 尾部偏差（tail-divergence） | 折叠缺失尾部为单条 text | 折叠缺失尾部为单条 `{role:"user", content}` |
| 中段损伤 / 主动重置 | 折叠全量 + 清空 parent | 折叠全量为单条 `{role:"user", content}` |
| 工具续传 | `messages: []` + `task_parameters.tool_result` | 发送 `[assistant(tool_calls), tool(result)]` 消息对 |
| 子代理 | `task_parameters.isSubAgent` + 缩减工具集 | 缩减工具集 + 透传 `isSubAgent` / `subAgent_type` / `subAgent_prompt`（见 D5） |

**理由**：v2 是 OpenAI 兼容协议，没有 `parent_message_id` 概念，续传完全依赖客户端回传的完整 `messages`。因此 v2 路径下"续传"= 发送客户端历史中尚未被上游确认的增量部分。

**备选**：v2 也发送完整 `messages` 历史（不做增量）。否决——会显著增加 prompt 长度，且与既有折叠/增量策略冲突，容易触发上游长度限制。

### D3: 链状态成为 v2 续传的唯一依据

v2 不返回 `parent_message_id`，因此 `lastResponseMessageId` 追踪在 v2 路径下不再有上游语义。改为：

- 保留 `chainStates`（`prefixChain` / `prefixLen` / `lastReplyHash`）作为续传判定依据。
- `classifyDivergence()` 逻辑复用，但 `parentMessageId` 不再参与请求体（v2 无此字段）。
- 续传判定：`chainState` 存在且客户端历史前缀匹配 → 只发送增量；否则 → 折叠全量。
- `lastResponseMessageId` 仍记录（用于日志与 `codearts` 元数据回传），但不影响 v2 请求体。

**理由**：链指纹是通道无关的，可直接复用；`parent_message_id` 是 v1 专有概念。

**风险**：v2 无上游侧会话锚点，若客户端历史与链状态不一致，只能靠折叠全量兜底（已有逻辑）。

### D4: SSE 解析新增 v2 归一化分支

`parseSSE` 保持产出 `CodeArtsSSEEvent`，但新增对 OpenAI 形状的识别与归一化：

```
输入: { id, object:"chat.completion.chunk", model, choices:[{index, delta:{role,content,reasoning_content,tool_calls}, finish_reason}], usage? }
归一化: {
  delta: choices[0].delta,
  prompt_tokens: usage?.prompt_tokens,
  completion_tokens: usage?.completion_tokens,
  ...
}
```

识别方式：事件对象含 `choices` 数组且 `choices[0].delta` 存在 → 走 v2 归一化；否则按 CodeArts 原生形状处理。

**理由**：`chat-stream.ts` / `chat.ts` 的消费循环、错误恢复、链重建逻辑可完全复用，只需在解析层做形状归一化，改动面最小。

**备选**：在 `chat-stream.ts` 内新增独立 v2 消费循环。否决——会复制大量错误恢复/链重建逻辑，维护成本高。

### D5: 子代理字段直接透传

v2 请求体**支持**子代理字段（已实测确认）。处理方式：

- 保留 `resolveTools()` 的子代理工具过滤（`deriveSubAgentTools`），使子代理请求只携带缩减工具集。
- 请求体透传 `isSubAgent: true`、`subAgent_type`、`subAgent_prompt`，与 v1 原生语义一致。

**理由**：v2 支持子代理字段，无需降级；直接透传可保持子代理的完整语义（独立 prompt + 缩减工具集 + 上游子代理路由）。

### D6: 工具续传改为标准 OpenAI tool 消息

v2 下工具续传不再使用 `task_parameters.tool_result`，改为：

```
[
  { role: "assistant", content: null, tool_calls: [...] },
  { role: "tool", tool_call_id: "...", content: "<result>" }
]
```

非内置工具的 tool result 仍按既有策略合并进 user 文本（避免上游报 unknown tool）。

**理由**：OpenAI 兼容协议的标准工具续传形式，v2 通道预期支持。

### D7: `reasoning_content` 与链指纹

`normalizeForChain` 当前把非空 `reasoning_content` 计入哈希。v2 默认返回 reasoning，而客户端回传时可能不带 reasoning → 哈希失配 → 误判 divergence。

处理：链指纹计算时**统一忽略 `reasoning_content`**（无论是否为空），即从 `normalizeForChain` 的哈希输入中移除该字段。

**理由**：reasoning 是上游生成的中间产物，客户端不保证回传；把它计入指纹必然导致误判。移除后指纹只覆盖客户端可控字段（role/content/name/refusal/tool_calls/tool_call_id）。

**备选**：保留 reasoning 但要求客户端回传。否决——不可控。

**影响**：`chat-translate.test.ts` 与 `chat-request-context.test.ts` 中涉及 reasoning 的断言需同步更新。

### D9: 缓存用量改用上游真实 `usage`

v2 通道**返回** `usage` 字段（已实测确认）。处理方式：

- 流式：从含 `usage` 的 chunk 读取 `prompt_tokens` / `completion_tokens`，并透传 `prompt_tokens_details`（若上游提供）。
- 非流式：直接使用上游 `usage`。
- `computeCacheUsage` 的估算逻辑保留作为兜底：当上游未返回 `prompt_tokens_details` 时仍按 divergence 估算。

**理由**：真实值优于估算值；保留估算兜底可兼容上游未返回 usage 的场景。

### D8: 错误恢复路径适配

- `ChatAgent.00001216`（prompt 超长）：v2 下仍可能触发，保留 forceResync 全量折叠重试。
- 限流重试（`.429`）：保留。
- tail-divergence 修复失败回退全量：保留。
- `ChatAgent.00001007`：v2 下预期不再出现；若出现则按普通上游错误处理。

**理由**：错误恢复逻辑与通道无关，仅请求体构造不同。

## Risks / Trade-offs

- **[v2 不支持子代理字段]** → 降级为普通 turn + 缩减工具集（D5）；若实测支持则补充字段。
- **[v2 不支持 `tool_stream` 或工具续传格式]** → 实测确认；不支持时回退为把 tool result 合并进 user 文本（既有非内置工具策略）。
- **[v2 无 `parent_message_id`，续传完全依赖客户端历史]** → 链指纹 + 折叠全量兜底；客户端不回传完整历史时退化为每轮全量折叠（功能可用，成本上升）。
- **[reasoning_content 计入指纹导致误判]** → D7 移除该字段。
- **[v2 通道对 `max_tokens` 上限更严格]** → 默认 32000（实测值）；超限时上游报错，由既有错误路径暴露。
- **[BREAKING：v1 通道不再使用]** → 若 v2 出现不可用，需回滚到 v1（v1 对 `glm-5.3` 不可用，但其他模型可用）。回滚方式：将 `HUAWEI_V2_CHAT_PATH` 指向 v1 路径不可行（协议不同），需代码回滚。
- **[既有测试大量依赖 v1 请求体形状]** → 需同步更新 `chat-request-context.test.ts`、`chat.test.ts`、`chat-translate.test.ts`、`stream-recovery.test.ts`、`error-recovery.test.ts`、`proactive-reset.test.ts`、`cache-usage.test.ts`。

## Migration Plan

1. 新增配置项与 `getChatUrl()`，默认指向 v2。
2. 新增 `buildV2RequestBody()` 与 v2 SSE 归一化，保持 v1 代码路径暂时可达（便于对比验证）。
3. 切换 `chat-stream.ts` / `chat.ts` 到 v2 路径。
4. 更新链指纹策略（D7）。
5. 更新测试并 `pnpm test`。
6. 端到端验证：用临时 key 调 `/v1/chat/completions` 测 `glm-5.3`，确认返回 `reasoning_content`。
7. 清理 `scripts/` 下临时探针脚本（保留 `probe-v2-channel.ts`）。

**回滚**：代码回滚到 v1 路径（git revert）。无数据迁移，无持久化状态变更。

## Open Questions

- ~~v2 通道是否支持子代理字段（`isSubAgent` / `subAgent_type`）？~~ **已确认支持**：v2 请求体直接透传子代理字段，不再降级为普通 turn。
- ~~v2 通道的 `max_tokens` 实际上限是多少？~~ **已确认上限为 65536**：实测 65536 成功、65537 起返回 `InferHub.001001005.400`；默认值与上限均取 65536，并对客户端传入值 clamp。
- ~~v2 通道是否返回 `usage` 字段？~~ **已确认返回**：缓存估算升级为使用上游真实 `usage` 值。