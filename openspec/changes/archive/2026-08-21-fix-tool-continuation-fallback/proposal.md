# Fix Tool Continuation Fallback

## Why

当客户端历史出现「纯工具续传段」（`assistant[tool_call]` + `tool[结果]`、无新 `user` 消息）时，tail-divergence 补发会把缺失段折叠成空字符串，随后被兜底逻辑替换成**首条 user 消息**重复发给上游。上游因而每轮都收到同一条 user、永远拿不到工具结果，模型反复执行同一动作，对话「很快开始重复」。这是从真实日志（`tmp-log.log`）中实证的 Bug：连续 4 轮 proxy 发给 CodeArts 的都是同一条 `@openspec-explore` user 消息，上游重复输出相同文本。

## What Changes

- **P0 修复 tail-divergence 兜底**：`buildRequestBody` 中 tail-divergence 分支的 `foldMissingSegment` 对无 user 补发段返回空字符串时，禁止用 `extractUserMessage`（首条 user）兜底。应保留缺失段的真实语义（工具调用上下文与工具结果，带 `[工具执行结果]` 标注）折叠后透传给上游，使上游看到真实增量。纯工具段应被视为合法续传，而非「新用户请求」。
- **P1 稳定工具消息哈希**：统一 `normalizeForChain` 与 proxy 重建 assistant 消息（`chat.ts`/`chat-stream.ts`）对 `tool_calls.type`、`reasoning_content`、`arguments` 的序列化，使 `boundaryIsLastReply` 对工具助手消息稳定成立，让正常工具续传回归 normal 分支（该分支已具备正确的 `[工具执行结果]` 合并逻辑）。
- **P2 回归测试**：为「纯工具续传尾部被正确折叠/透传」「工具消息哈希稳定性」补充测试用例，防止回归。

## Capabilities

### New Capabilities

（无新增能力）

### Modified Capabilities

- `chain-divergence-detection`: 修改「修复会折叠缺失尾部」相关 REQUIREMENTS——补充纯工具段续传的语义（不得退化为重复首条 user），并强化「消息哈希规范化」对工具调用消息的稳定性约束。

## Impact

- `src/upstream/huawei/chat-request.ts`：`buildRequestBody` 的 tail-divergence 分支、`classifyDivergence` 的边界判定。
- `src/upstream/huawei/chat-translate.ts`：`foldMissingSegment`、`normalizeForChain`。
- `src/upstream/huawei/chat.ts` / `chat-stream.ts`：assistant 消息重建时的序列化一致性。
- 测试：`chat-request-context.test.ts`、`chat-translate.test.ts` 补用例。
- 无新增依赖；行为变更默认开启（跟随 `CHAIN_DIVERGENCE_REPAIR_ENABLED`），无 breaking change。
