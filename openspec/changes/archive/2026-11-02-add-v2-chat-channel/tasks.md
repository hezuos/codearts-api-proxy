## 1. 配置与端点

- [x] 1.1 在 `src/config.ts` 的 `AppConfig` 新增 `huaweiV2ChatPath: string` 字段
- [x] 1.2 在 `config` 对象中读取 `HUAWEI_V2_CHAT_PATH`，默认 `/api/v2/chat/completions`
- [x] 1.3 新增 `getChatUrl()` 辅助函数，返回 `${config.huaweiChatHost}${config.huaweiV2ChatPath}`
- [x] 1.4 在 `.env.example` 补充 `HUAWEI_V2_CHAT_PATH` 说明
- [x] 1.5 在 `src/config-env.test.ts` 补充 v2 路径默认值与覆盖的断言

## 2. v2 请求体构造

- [x] 2.1 在 `chat-request.ts` 新增 `buildV2RequestBody(request, session, options)`，返回与 `buildRequestBody` 同形状的结果
- [x] 2.2 实现 v2 请求体字段：`model` / `max_tokens`（默认 262144 = 256k，不设上限）/ `tool_stream: true` / `stream` / `messages`
- [x] 2.3 实现 `messages` 构造：冷启动与折叠场景输出单条 `{role:"user", content}`
- [x] 2.4 实现热链续传：仅发送最新 user turn
- [x] 2.5 实现工具续传：输出 `[assistant(tool_calls), tool(result)]` 消息对
- [x] 2.6 实现非内置工具 result 合并进 user 文本的降级路径
- [x] 2.7 实现子代理字段透传：`isSubAgent: true` + `subAgent_type` + `subAgent_prompt`，并缩减工具集
- [x] 2.8 复用 `classifyDivergence()` 与 `chainStates` 作为续传判定依据，请求体不再携带 `parent_message_id`
- [x] 2.9 保留 `proactiveReset` 与 `forceResync` 触发逻辑

## 3. v2 SSE 归一化

- [x] 3.1 在 `chat-protocol.ts` 扩展 `parseSSE`，识别含 `choices[0].delta` 的 OpenAI 形状事件
- [x] 3.2 将 OpenAI 形状归一化为 `CodeArtsSSEEvent`（`delta` / `prompt_tokens` / `completion_tokens`）
- [x] 3.3 保留 `usage` 字段透传（含 `prompt_tokens_details`），缓存用量优先用真实值
- [x] 3.4 保留畸形行跳过与 `PROTOCOL_ERROR` 容错行为
- [x] 3.5 在 `chat-protocol` 相关测试中补充 v2 形状归一化断言

## 4. 流式与非流式切换

- [x] 4.1 `chat-stream.ts` 的 `chatUrl` 改用 `getChatUrl()`
- [x] 4.2 `chat.ts` 的 `chatUrl` 改用 `getChatUrl()`
- [x] 4.3 两处调用 `buildV2RequestBody()` 替代 `buildRequestBody()`
- [x] 4.4 确认 `reasoning_content` 在流式 delta 与非流式 `message.reasoning_content` 中均被保留
- [x] 4.5 确认错误恢复路径（00001216 / tail-divergence / 限流）在 v2 下仍生效

## 5. 链指纹策略调整

- [x] 5.1 修改 `normalizeForChain()`，从哈希输入中移除 `reasoning_content`
- [x] 5.2 更新 `chat-translate.test.ts` 中涉及 reasoning 的断言
- [x] 5.3 更新 `chat-request-context.test.ts` 中涉及 reasoning 的断言
- [x] 5.4 新增断言：带 reasoning 的回复与客户端回传的无 reasoning 副本哈希相等

## 6. 测试更新与验证

- [x] 6.1 更新 `chat.test.ts` 以适配 v2 请求体形状
- [x] 6.2 更新 `stream-recovery.test.ts` 与 `error-recovery.test.ts`
- [x] 6.3 更新 `proactive-reset.test.ts` 与 `cache-usage.test.ts`
- [x] 6.4 新增 `chat-v2-request.test.ts`：覆盖 v2 请求体各场景（冷启动/续传/工具续传/子代理）
- [x] 6.5 运行 `pnpm test` 全绿
- [x] 6.6 运行 `pnpm run lint` 与 `pnpm run build` 无错误

## 7. 端到端验证与清理

- [ ] 7.1 用临时 key 调本地代理 `/v1/chat/completions` 测 `glm-5.3`，确认 HTTP 200 且返回 `reasoning_content`
- [ ] 7.2 验证 `GLM-5.2` 与 `deepseek-v4.1-flash` 在 v2 下仍正常
- [ ] 7.3 验证多轮续传（第二轮请求只发送增量）
- [ ] 7.4 验证工具续传（tool_call → tool result → 下一轮）
- [x] 7.5 清理 `scripts/` 下临时探针脚本，保留 `probe-v2-channel.ts`
- [x] 7.6 更新 `AGENTS.md` 与 `CHANGELOG.md` 记录 v2 通道切换