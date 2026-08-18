## Why

当客户端(如 opencode)从其他 provider(如 OpenAI)切换到 CodeArts 时,CodeArts 服务端对当前会话毫无历史;而 proxy 现有的 `extractUserMessage` 只会把 `messages` 的最后一段用户消息转发给 CodeArts,导致 CodeArts 服务端"失忆",只能基于孤零零的一句话作答。同样的问题也会在 proxy 缓存(内存 `lastResponseMessageId` Map)未命中时出现:未命中意味着无法通过 `parent_message_id` 续传,而 CodeArts 服务端历史是否存在又无法预知。若此时仍只转发最后一段,切换 model/provider 后的对话上下文就会丢失。

## What Changes

- 在"缓存未命中"场景下,将客户端传入的**完整消息历史**折叠为 CodeArts 可接受的单条 `text` 消息注入上游 `messages` 数组,替代当前"只取最后一段"的行为。
- 缓存命中(客户端传了 `parent_message_id`,或 proxy 内存 Map 有 `lastResponseMessageId`)时保持现有增量续传行为不变。
- 新增"完整上下文注入"的折叠格式约定(带 role 标记的纯文本)与截断策略,保证长历史安全注入。
- 新增工具执行结果的文本化处理规则:CodeArts 无法理解的 OpenAI 侧工具轮次折叠为文本标记,不上报 `tool_result`。
- 本轮注入后,CodeArts 返回 `response_message_id`,proxy 照常记录,下一轮自然回到增量协议 —— 完整注入是一次性的"上下文移植"。

## Capabilities

### New Capabilities

- `full-context-injection`: 缓存未命中或跨 provider 迁移时,将完整对话历史折叠为标准文本注入 CodeArts 请求的能力;包含折叠格式、截断阈值、判定条件与工具轮次文本化规则。

### Modified Capabilities

- `codearts-request-forwarding`: REQ-FWD-001/REQ-FWD-002 的现有"续传"与"消息构建"要求需要补充"上下文缺失时的全量注入"场景,使转发行为在缓存未命中时不再只转发最后一段。

## Impact

- **代码**:
  - `src/upstream/huawei/chat-request.ts` — `buildRequestBody` 中消息构建分支;新增折叠注入逻辑与判定条件
  - `src/upstream/huawei/chat-translate.ts` — 新增折叠函数(如 `foldFullConversation`),`extractUserMessage` 保持供增量场景使用
  - `src/config.ts` — 新增截断阈值等配置项(预留)
- **文档**: `docs/codearts-api-spec.md` 补记"折叠注入"请求形态(待 spike 验证后确认)
- **风险**: CodeArts 对"新 chat_id + 超长折叠单条 text"的接受度**未经验证**,是本变更的最大未知数,须先经 spike 验证再谈实现细节