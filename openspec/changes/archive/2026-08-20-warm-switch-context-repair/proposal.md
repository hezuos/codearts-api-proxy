## Why

full-context-injection-on-cache-miss 变更只覆盖了"冷启动切换"（Map 未命中 → 全量折叠注入），但真实场景中更常见的是"热切换回归"：同一会话在 CodeArts 与其它 provider 之间来回切换（或消息被编辑/重生成/窗口裁剪）后回到 CodeArts，此时内存 Map 仍持有旧的 `lastResponseMessageId`，`trackedParent` 一票否决注入 → 代理按陈旧 parent 增量续传，CodeArts 服务端只接着自己存的历史续答，客户端历史中外部 provider 产生的轮次被静默丢弃，造成"切换 provider 信息丢失"。此外 `FULL_CONTEXT_INJECTION_ENABLED` 默认关闭且未写入 README 环境变量表，默认截断阈值 8000 字符对 GLM-5.2 等大窗口模型过度保守，冷启动注入也常被截断丢中段。

## What Changes

- 引入**热链分叉检测**：为每个 `chat_id` 在内存中记录客户端消息前缀哈希链（Merkle 式累积哈希）、链长度、以及代理上次返回的 assistant 回复哈希；每次请求（非工具续传、非子代理、且客户端未传 `parent_message_id`）校验客户端本次消息是否续接代理已知链。
- 分叉检测结果分两类处理：
  - **尾部断裂**（前缀链一致，仅 `new[L] ≠ lastReply`，即末尾多出外部轮次）：**末尾补发缺失段** —— 折叠 `messages[L..]` 缺失部分为单条 `text`，附带"仅作参考"辅助提示词与 `[当前用户请求]` 标注，`parent_message_id` 复用旧节点（服务端继续加载旧链），避免全量重置。
  - **中段损伤**（前缀链在 L 之前失配，即编辑/重生成/裁剪）：**全量折叠重置** —— `parent_message_id=""` 整体重发（服务端旧链已被改写，不可补，只能重置）。
- 末尾补发失败（上游报错）时回退全量折叠重置兜底。
- 冷启动全量注入逻辑保持不变；`FULL_CONTEXT_INJECTION_ENABLED`、`FULL_CONTEXT_MAX_CHARS` 机制沿用。
- 文档收尾：README 环境变量表补充三个 `FULL_CONTEXT_*` 变量及 `FULL_CONTEXT_MAX_CHARS_BY_MODEL` 示例，默认阈值建议按模型放大。

## Capabilities

### New Capabilities

- `chain-divergence-detection`: 检测"代理已知的热链"与"客户端当前消息历史"之间的分叉，区分尾部断裂（可末尾补发）与中段损伤（需全量重置）的能力；包含内存链状态定义、检测算法、分级处理策略与失败回退。

### Modified Capabilities

- `full-context-injection`: "缓存命中保持增量"要求补充"热链断裂时末尾补发缺失段"场景，将 `folded history format` 扩展支持"缺失段 + 辅助提示词 + 当前请求"的补发折叠格式。
- `codearts-request-forwarding`: `REQ-FWD-001` 续传逻辑需补充"热链分叉检测与分级处理"分支 —— 前缀一致时走增量续传，尾部断裂走末尾补发，中段损伤走全量重置。

## Impact

- **代码**:
  - `src/upstream/huawei/chat-request.ts` — 新增链状态记录（前缀哈希链 / 链长 / lastReply 哈希，与 `lastResponseMessageId` 同 TTL 清理）；`buildRequestBody` 注入判定前增加分叉检测分支；末尾补发构造与全量重置回退
  - `src/upstream/huawei/chat-translate.ts` — 新增 `foldMissingSegment`（缺失段 + 辅助提示词 + `[当前用户请求]`）；现有 `foldFullConversation` 保持（全量重置/冷启动用）；新增链哈希辅助函数（normalize 复用 `normalizeMessageContent`）
  - `src/upstream/huawei/chat-stream.ts` — 成功轮时与 `setLastResponseMessageId` 同步更新链状态；末尾补发失败回退全量重置的检测
  - `src/config.ts` — 新增辅助提示词模板配置项（如 `MISSING_CONTEXT_HINT`），`FULL_CONTEXT_MAX_CHARS_BY_MODEL` 文档化
- **文档**: `README.md` 环境变量表补全；`docs/codearts-api-spec.md` 3.3.x 补记"热链分叉检测与末尾补发"请求形态；`AGENTS.md` 更新已知约定
- **测试**: `chat-translate.test.ts` 补 `foldMissingSegment` 与链哈希边界用例；新增分叉检测单元测试（前缀一致/尾部断裂/中段损伤/工具续传/子代理/单轮）
- **风险**: 末尾补发依赖"分叉前旧链在服务端仍有效"，有效性不可验证 → 失败回退全量重置兜底；新增内存状态与 `lastResponseMessageId` 同生命周期，重启后自然降级为冷启动注入，行为正确