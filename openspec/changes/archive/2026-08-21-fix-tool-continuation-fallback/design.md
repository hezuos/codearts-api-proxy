# Design: Fix Tool Continuation Fallback

## Context

动机见 `proposal.md - Why`。相关现状（代码事实）：

- `chat-request.ts` `buildRequestBody` 的 tail-divergence 分支（L326-333）：
  ```ts
  const folded = foldMissingSegment(request.messages, suffixStart, resolveFullContextMaxChars(modelId));
  messagesBody = [{ type: "text", content: folded || extractUserMessage(request.messages) }];
  ```
- `chat-translate.ts` `foldMissingSegment`（L292-321）：以「段内最后一条必须是 user」为前提折叠，纯工具段（`lastUserIndex < 0`）直接返回 `""`。
- `extractUserMessage`（L49-58）实际是**从后往前取出第一个 `role !== assistant && role !== tool` 的消息**——即「最近一次用户或系统消息」，并非「首条 user」。在纯工具段尾部时它取到的是最早那条 `[@openspec-explore]` user。
- `chat.ts`（L160-166，非流式）重建的 `assistantMessage` **含** `reasoning_content`，而 `chat-stream.ts`（L402-407，SSE 主流路径）重建的**不含**；`cleanToolCalls`（非流式）恒有 `tool_calls[].type="function"`，`cleanToolCallDeltas`（流式）仅在客户端显式带 `type:"function"` 时才保留属性。**两处重建路径字段不一致，是「proxy 重建 vs 客户端 echo」哈希漂移的全部来源。**
- `normalizeForChain`（L60-78）对 `tool_calls[].type`、`reasoning_content`、`arguments` 为直存直比，未归一化。
- `setChainState` 在 turn 成功后执行：`prefixLen` = 本次 `request.messages.length`；`lastReplyHash` = `assistantMessage`（经 `normalizeForChain`）的哈希。

## Goals / Non-Goals

**Goals:**
- 纯工具段（`assistant[tool_call] + tool[结果]`，无新 user）作为 tail-divergence 补发时，携带真实工具语义上送，绝不退化为重复已发送过的 user/system 消息。
- 工具助手消息在「proxy 重建」与「客户端记录的同一轮」之间边界哈希稳定（含流式/非流式两路径一致），使正常工具续传回归 normal 分支。
- 用回归测试锁住上述两个行为。

**Non-Goals:**
- 不改 normal 分支已有的 `[工具执行结果]` 合并逻辑。
- 不改造成链判定语义漂移：`duplicate/stale`、`middle-damage` 全量重置、sub-agent / caller-parent / tool-continuation 旁路逻辑保持原样。
- 不新增依赖、不新增配置项。

## Decisions

### D1：tail-divergence 补发无 user 段时，不再退化为已发送过的 user/system

- **补发段两种起点**（`classifyDivergence` 的产物）：
  - `boundaryIsLastReply=false` → `suffixStart=prefixLen`，段 = `[assistant(boundary), tool]`（含上一条回复本身）。
  - `boundaryIsLastReply=true` → `suffixStart=prefixLen+1`，段 = `[tool]`。
  - 两种形态都无 user，`foldMissingSegment` 目前都返回 `""`，P0 必须同时支持。
- **修改 `foldMissingSegment`**：当段内无 user 时，不再返回 `""`，改为按工具段真实语义折叠——以 role 标注折叠 assistant 工具调用文本 + 工具结果（复用 `foldMessageSegment`，其对 assistant 的 `[调用工具: name(args)]`（L385-391）与 tool 的 `[tool result: name]`（L396-400）已完整文本化，无需新机制；预算用 `TOOL_RESULT_HEAD_TAIL_CHARS` / `truncateMissingSegment`），段首不加「这是新用户请求」语义（不套用 `[当前用户请求]` 结构），仅作为缺失续传上下文（沿用 `MISSING_CONTEXT_HINT` 语义区分「历史补发」与「当前任务」）。
  - **注意**：`truncateMissingSegment(hint, segments, current, maxChars)` 的 `current`（`[当前用户请求]\n…`）与 `fixedLength` 预算计算需适配「无 user 段」场景（传空 current / 调整开销）。
- **兜底链**：修复后 tail-divergence 正常路径下 `suffixStart < messages.length`（至少差 1），且「无 user 段」不再返回空，因此 `folded || extractUserMessage(...)` 的兜底是**不可达的防御分支**。若异常进入，SHALL NOT 发送历史 user/system 作为请求体；改为返回空 `messages` 依赖 parent 推进或直接按 middle-damage 全量重置，与 spec「不得重复已确认消息」保持一致。
- **备选**（均否决）：
  - 空 `messages` + 纯 parent 推进——依赖 CodeArts 增量协议，未验证，风险高。
  - 直接丢弃工具段（仅 parent 推进）——丢工具结果，破坏上下文。

### D2：规范化工具助手消息的哈希，并统一两条重建路径

- **归一化（`normalizeForChain`）**：
  - `tool_calls[].type`：`null` / `undefined` / `""` 与字面 `"function"` 归一为同一值。
  - `reasoning_content`：`null` / `undefined` / `""` 归一为同一值。
  - `arguments`：明确按来源字符串序列化（不做 pretty-print，避免引入差异）。
  - 归一化**仅作用于链哈希**，不改变透传给上游的任何消息本体。
- **统一重建路径**：`chat.ts` 与 `chat-stream.ts` 的 `assistantMessage` 用同一套字段规则构建——`reasoning_content` 统一（建议流式路径同样记录上游返回的 reasoning 内容；若未返回则与 `chat.ts` 一致记为 `undefined`）、`tool_calls[].type` 缺省补 `"function"`。以「两路径产出同一 `normalizeForChain` 结果」为对齐基准。
  - **注意**：该 type 规则**仅作用于链状态重建用 `assistantMessage`（用于 `lastReplyHash`）**，不得改动 `cleanToolCallDeltas` 的 `type` 保留逻辑（L229-230，上游未给 `"function"` 时对客户端省略该字段）——客户端可见的 tool_call 消息保持不变。
- **保单关系**：即使客户端对 `arguments` 等字段做了 proxy 不可控的重新序列化导致哈希仍不等（`boundaryIsLastReply=false`），P0 修复已保证工具段被正确折叠上送，不再退化为重复消息——P1 是**稳定性增强**而非关键路径。

### D3：回归测试

测试风格沿用项目约定：`assert` + 手动串联（无框架），co-location 于 `chat-translate.test.ts` 与 `chat-request-context.test.ts`，复用现有 helper（`assistantWithToolCall` / `toolResult` / `bodyText` / `hash` / `seedChain`）。

#### 测试用例矩阵

| # | 文件 | 级别 | 场景 | 输入（构造） | 核心断言 |
|---|------|------|------|--------------|----------|
| T1 | chat-translate | 单元 | `normalizeForChain` 对 `tool_calls[].type` 归一化 | 同一带 tool_call 的 assistant，type 分别为 缺省(undefined) / `"function"` / `""` | 三者 `normalizeForChain` 相等 |
| T2 | chat-translate | 单元 | `normalizeForChain` 对 `reasoning_content` 空值归一化 | 同一消息 `reasoning_content` 为 `undefined` / `null` / `""` | 三者相等；非空字符串与空值**不**相等 |
| T3 | chat-translate | 单元 | `arguments` 哈希区分 | 同 tool_call、不同 `arguments` 字符串 | 哈希不等；相同 `arguments` 相等 |
| T4 | chat-translate | 单元 | 重建两路径一致 | `chat.ts` 风格（含 `reasoning_content` + type="function"）vs `chat-stream.ts` 风格（无 reasoning + type 缺省） | 两消息 `normalizeForChain` 相等（归一化拉平差异） |
| T5 | chat-request-context | 集成 | 重建→链→echo→normal（P1 端到端） | seed：prefix=[system,user]，`lastReplyHash`=按重建规则（type="function"，reasoning 空）计算；下一轮 messages=[system,user,echo(同 assistant 但 type 缺省、reasoning null),tool(可追溯)] | `classifyDivergence` = normal，`suffixStart`=prefixLen+1，body 用 parent 链续传 |
| T6 | chat-translate | 单元 | `foldMissingSegment` 无 user 段（assistant+tool） | messages=[system,user,assistant(ext,tc),tool(result)]，`suffixStart`=2 | 返回非空；含 `[调用工具: ...]` 与 `[tool result: ...]`；**不含** `[当前用户请求]` |
| T7 | chat-translate | 单元 | `foldMissingSegment` 纯 tool 段 | messages=[...,assistant(reply),tool(result)]，`suffixStart` 落在 assistant 后 | 返回非空；含 `[tool result: ...]`；不含 `[当前用户请求]` |
| T8 | chat-request-context | 功能 | tail-divergence 纯工具段（边界不相等） | seed：prefix=[sys,user]，lastReply=assistant("new answer")；messages=[sys,user,assistant(external,tc),tool(result)] | divergence=tail，`suffixStart`=2，body 含 `[调用工具:` 与 `[tool result:`，**不含** 首条 user 内容，parent 保持 |
| T9 | chat-request-context | 功能 | tail-divergence 纯 tool 段（边界相等） | seed：lastReply=assistant("good",tc)（与 echo 一致）；messages=[sys,user,assistant("good",tc),tool(result)] | `boundaryIsLastReply`=true → `suffixStart`=3，body 含 tool result，**不含** 已确认 user/system 内容，parent 保持 |
| T10 | chat-request-context | 回归 | 可追溯 tool + 末尾 user 仍判 normal | messages=[sys,user,assistant(new reply,tc),tool(call_1),user(next)] | divergence=normal（工具结果增量前进） |
| T11 | chat-request-context | 回归 | 含 user 段 tail-divergence 折叠不变 | 现有 `testTailDivergenceSkipsParentReply` 保持绿 | 输出仍含 hint + 外部段 + `[当前用户请求]`，不重复 parent 已覆盖内容 |
| T12 | chat-request-context | 回归 | 不可追溯 tool → middle-damage | 现有 `testUntraceableToolResetsParent` 保持绿 | divergence=middle-damage，parent="" |
| T13 | chat-translate | 回归 | 无 user 段折叠受预算约束 | 大 tool result + 小 `maxChars` | 折叠长度 ≤ `maxChars`+常量开销；含截断 marker |

> T1-T4 对应 P1；T5 校验 P1 端到端；T6-T9 对应 P0；T10-T12 防既有行为回归；T13 防折叠超预算。

#### 补充：会话消息→CodeArts 传递通道正交场景

以下场景覆盖「客户端消息如何被选择性地传递到 CodeArts」的每一条正交通路（既有/旁路/修复后），确保本 change 不破坏其它传递行为。参考历史 `warm-switch-context-repair` 测试清单（其 6.1 a-l）扩充：

| # | 传递通道 | 输入 | 预期（发给 CodeArts 的 body / 行为） |
|---|----------|------|-------------------------------------|
| T14 | normal + 末尾纯 tool | messages=[sys,user,assistant(tc),tool]，chain 正常 | 走 normal 分支：body = 最近 user 上下+`[工具执行结果]`+tool 内容（既有逻辑回归锚定） |
| T15 | normal + tool + 末尾 user | messages=[sys,user,assistant(new reply,tc),tool(call_1),user(next)] | `classify=normal`，parent 续传，工具结果随增量前进 |
| T16 | tool-continuation 旁路（structured） | `codearts.tool_results` 非空 | bypass 检测：body.messages=[]，tool 结果走 `task_parameters.tool_result`；成功后链状态更新 |
| T17 | caller-provided parent 旁路 | `codearts.parent_message_id` 非空 | 信任 linkage，跳过检测（body.parent=full 用） |
| T18 | sub-agent 旁路 | `codearts.sub_agent` 存在 | 不修复、不影响子代理行为 |
| T19 | duplicate/stale 自动重置 | messages.length == prefixLen 且前缀匹配 | 不抛错；parent="" + 全量折叠重发（会话可继续，非历史脚本期望的「拒绝」） |
| T20 | 冷启动无链状态 | 新 chat_id / proxy 重启后 | 走 full-context 注入或首条 user 普通增量，不参与分叉检测 |

#### 会话级端到端场景（真实链路 playbook）

参考 `scripts/verify-warm-switch-context-real.ts` 的结构（真实 API 请求、每步记录 `divergence/suffixStart/fullContextInjected`、不依赖 mock），但补齐真实 bug 的**工具对**场景与「自动重置后可继续」的新语义。每个场景用独立 `chat_id` 隔离：

| # | 场景 | 会话脚本 | 成功判据 |
|---|------|----------|----------|
| S1 | 正常多轮（工具对贯穿） | system → user → assistant(tc) → tool → user → … 连续多轮 | 每轮返回新 `response_message_id`；后续轮上游能感知工具结果（回复体现出已看到工具输出）；日志 `divergence=normal` 且无 `foldedChars` 爆增 |
| S2 | 纯工具段热切换（真实 bug 场景） | 在 CodeArts 上轮回复后插入外部 `[user, assistant]`，随后只发 `[assistant(外部 tc), tool]` 无新 user | `divergence=tail-divergence`；发出 body 包含 `[调用工具:` 与 `[tool result:`，**不含**首条 user 内容；`parent` 复用旧节点；继续对话不再重复 |
| S3 | 中段损伤重置后恢复 | 修改早期 user 后重发完整历史 | `divergence=middle-damage`、`parent=""`、全量折叠；随后一轮恢复 `normal` 增量 |
| S4 | duplicate/stale 自动重置后可继续 | 原样重发 S3 同历史后再追加一条 user | 不抛错、不重复上游调用死循环；追加 user 后可继续正常对话 |
| S5 | 冷启动全量注入 | 新 chat_id 首轮 | `fullContextInjected=true` 或有普通增量；对话从首轮即可正常 |
| S6 | 打断/取消 | 首轮流未结束时断开 | 上游请求被 cancel；`lastResponseMessageId`/链状态不被脏写（下次请求回退正常） |

> S 系列实际通过扩展 `scripts/verify-warm-switch-context-real.ts`（或新增同风格脚本）运行真实链路；S1/S2 是本次修复的核心场景，S4 修正历史脚本「期望拒绝」的过时断言，S6 属边界冒烟。

**流式重建路径**：T4 覆盖两路径字段归一化；并在 `npm test` 的既有串联列表里确认改动不使 `chat-stream` 相关断言漂移（现有测试仅 `stream:false`，T5 已通过构造覆盖流式重建风格）。

## Risks / Trade-offs

- [工具结果很大 → 折叠文本超预算] → 复用 `truncateMissingSegment` + `TOOL_RESULT_HEAD_TAIL_CHARS`，保证不超过 `resolveFullContextMaxChars`；并建议按模型窗口配置 `FULL_CONTEXT_MAX_CHARS_BY_MODEL`（GLM-5.2 为 196608 token 量级）。
- [哈希归一化波及所有链哈希] → 圈定在链相关测试内回归；进程内无持久化，陈旧 `chainStates` 由既有 TTL 清除。
- [折叠工具段与自然轮次语义混淆] → 通过 role 标注 + `MISSING_CONTEXT_HINT` 让模型识别为续传而非新一轮用户输入。
- [客户端不可控序列化导致哈希仍不等] → 已由 P0 兜底（见 D2 保单关系），不阻塞。

## Migration Plan

行为随 `CHAIN_DIVERGENCE_REPAIR_ENABLED` 生效，无配置项、无数据迁移。发布后可回滚（旧逻辑为 `folded || extractUserMessage` 兜底）。

## Open Questions

无。
