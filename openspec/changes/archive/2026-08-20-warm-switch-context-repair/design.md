## Context

See proposal.md — Why. 现状：`buildRequestBody`（`src/upstream/huawei/chat-request.ts:159`）的注入判定仅凭 `trackedParent`（内存 Map 是否有 `lastResponseMessageId`）是否为空决定全量注入与否；Map 有记录即走增量续传。上一变更（full-context-injection-on-cache-miss）已实现冷启动全量折叠（`foldFullConversation`，`chat-translate.ts:332`），但"热切换回归"场景下 Map 仍热 → 增量续传 → 外部 provider 轮次被静默丢弃。CodeArts 协议约束：`messages` 为单条 `{type:"text"}` 无 role 字段（docs/codearts-api-spec.md 3.3），工具结果仅经 `tool_result` 传递且必须匹配 CodeArts 自己发出的 `toolCallId`，服务端历史无法被代理读回。

## Goals / Non-Goals

**Goals:**
- 检测"代理已知 CodeArts 热链"与"客户端当前消息历史"之间的分叉，且区分尾部断裂（可补）与中段损伤（须重置）
- 尾部断裂时**只补缺失段**（附加辅助提示词 + `[当前用户请求]`），复用旧 `parent_message_id`，避免全量重置
- 中段损伤时全量折叠重置兜底；冷启动注入行为保持不变
- 新增状态与 `lastResponseMessageId` 同生命周期（同一 TTL 清理、重启后自然降级），零持久化

**Non-Goals:**
- 不改变 CodeArts 协议本身的 messages 结构（仍单条 text，不做多元素/role 字段尝试）
- 不做 proxy 侧会话历史持久化（仍是内存态，重启丢失）
- 不改变 tool 续传、子代理、冷启动注入的现有路径（各自显式排除）
- 不尝试"验证服务端旧链是否仍有效"（不可验证，靠失败回退兜底）

## Decisions

### D1: 链状态定义 — 每 chat_id 记录"代理最后确认的服务端所知"

内存新增单个 `Map<chat_id, ChainState>`（与 `lastResponseMessageId` 同 TTL 定时器清理，见 `chat-request.ts:46-65`），**不用三个独立 Map** 以避免同步更新/清理不一致：

```
interface ChainState {
  prefixChain:   string  // 客户端消息前缀的 Merkle 式累积哈希
  prefixLen:     number  // 该链覆盖的消息条数（客户端 messages 数组下标边界 L）
  lastReplyHash: string  // 代理最后返回给客户端的 assistant 回复规范化哈希
}
```

每次**成功**轮后（`chat-stream.ts:364` / `chat.ts:142` 更新 `setLastResponseMessageId` 处同步）更新；错误轮不更新。`Merkle` 式累积：`chain_i = H(chain_{i-1} | normalizeForChain(msg_i))`，只需存 32B 哈希 + 长度，不存原文。

**`normalizeForChain(msg)` 规范化**（新建，不复用 `normalizeMessageContent`——后者只处理 content，不接收消息元数据）：
```
normalizeForChain(msg) = JSON.stringify({
  role: msg.role,
  content: normalizeMessageContent(msg.content),
  name: msg.name ?? null,
  refusal: msg.refusal ?? null,
  reasoning_content: msg.reasoning_content ?? null,
  tool_call_id: msg.tool_call_id ?? null,
  tool_calls: canonicalToolCalls(msg.tool_calls),
})

canonicalToolCalls(tool_calls) =
  tool_calls
    ?.slice()
    .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""))
    .map(tc => ({
      id: tc.id ?? null,
      type: tc.type ?? null,
      name: tc.function?.name ?? null,
      arguments: tc.function?.arguments ?? null,
    }))
  ?? []
```
`JSON.stringify` 的对象字段按上述固定顺序生成；tool calls 按 `id` 排序，消除客户端仅改变数组顺序造成的误判，同时纳入 `id`/`type`/name/arguments，避免不同工具调用被视为同一消息。

**备选 A：存完整消息引用数组。** 否决：内存占用随会话增长，且与"最小有状态设计"（README 架构说明）冲突。
**备选 B：整体数组 hash。** 否决：每轮消息都在追加，整体 hash 每轮都变，无法区分"正常延续"与"分叉"。
**备选 C：只记最近一条 hash。** 否决：无法发现"中段损伤"（编辑/裁剪发生在链中部时最近一条恰好匹配）。

### D2: 分叉分类 — 正常延续 / 尾部链分叉 / 中段损伤

收到请求（已排除 tool 续传 / 子代理 / 客户端传了 parent，见 D3）后，设 `L = prefixLen`，`N = messages.length`：

```
N < L                               ? ── 是 ──▶ 中段损伤 → 全量折叠重置
                                       └── 否 ──▶ new[0..L) == prefixChain ?
                                                     ├─ 否 ─▶ 中段损伤 → 全量折叠重置
                                                     └─ 是 ─▶ N == L ?
                                                                ├─ 是 ─▶ 重复/无新增消息 → 不向上游再次发送最后 user
                                                                │         （记录 duplicate/stale，返回可重试错误或复用已有响应）
                                                                └─ 否 ─▶ 校验 messages[L..] 整个尾部的结构（见下方"正常尾部定义"）
                                                                          ├─ 合法单轮延续 ─▶ 正常延续 → 现状增量续传
                                                                          ├─ 明确多轮/异常 ─▶ 尾部链分叉 → 末尾补发缺失段
                                                                          └─ 无法确认 ─▶ 中段损伤 → 全量折叠重置（见"无法确认兜底"）
```

**正常尾部定义**（messages[L..] 满足以下全部条件才算正常延续）：
1. 第一条的规范化哈希 == `lastReplyHash`（即代理上次返回的 assistant 回复）
2. 随后可以有 0 条或多条 `role == "tool"` 消息，但这些 tool 消息必须能**追溯到第一条 assistant 的 tool_calls**（即 tool 消息的 `tool_call_id` 匹配该 assistant 发出的某个 tool_call；不匹配视为异常）
3. 之后**恰好一条** `role == "user"` 消息收尾（即当前用户请求）
4. 不允许再出现任何额外的 `assistant` 消息或额外的 `user` 消息

反例：尾部 `[a2, u3, a3', u4]`（代理上次回复 a2 后又出现外部 provider 的完整 user→assistant 轮次 u3/a3'）→ 条件 4 不满足 → 尾部链分叉；尾部 `[a2, u3, u4]`（连续两个 user 轮次）→ 亦不满足 → 尾部链分叉；尾部 `[a_x, u3]`（第一条不是 lastReply）→ 条件 1 不满足 → 尾部链分叉。

**无法确认兑底**：若尾部结构怪异到无法判定（例如：客户端压缩/合并了消息、tool 消息无法追溯到第一条 assistant 的 tool_calls、或 role 序列不符合任何预期形态），**不得贸然补发**——补发错误的尾部可能让矛盾信息叠加进旧链。此时归入**中段损伤 → 全量折叠重置**。

**`N == L` 的处理**：`prefixChain` 记录的是上一次客户端请求的 messages，而该请求的 assistant 响应尚未出现在当时的 request 中。因此下一次正常请求通常应满足 `N > L`，在尾部包含 `lastReply` 和当前 user。`N == L` 只表示客户端重发了完全相同的历史，不能无条件再次调用 `extractUserMessage`，否则会把同一条 user 重复发送给 CodeArts。代理 SHALL 将其标记为 `duplicate/stale`，不向上游发送请求；如果无法复用已缓存响应，则返回明确的可重试错误。

- **尾部链分叉（tail-divergence）**：前缀完好，但 `messages[L..]` 不是合法的单轮延续——可能是 `new[L]` 根本不是代理上次回复（外部 provider 直接把上次回复顶替），也可能是后续夹入了外部 provider 的完整轮次（user→assistant）或多个 user 轮次。若 `messages[L]` 等于 `lastReply`，它已由 `parent_message_id` 覆盖，真正缺失段从 `L + 1` 开始；若不等于 `lastReply`，缺失段从 `L` 开始。旧链在服务端仍有效 → 复用 `chat_id` + 旧 `parent_message_id`，只折叠并追加缺失段。
- **中段损伤（middle-damage）**：前缀在 L 之前就失配，或尾部无法确认是否为合法延续 → 服务端存的链已被客户端改写（编辑/重生成/窗口裁剪）或无法安全关联，不能冒险补发，只能 `parent_message_id=""` + 全量折叠。

**备选：统一全量重置。** 否决：用户已明确"能避免全量折叠重置要尽可能避免"，尾部链分叉只补缺失段 token 开销小、语义保留更多。
**备选：逐条全量比对。** 与 D1 的 Merkle 链等价（每条都参与哈希），但无需存原文，成本已收敛为 O(L) 时间 + O(1) 存储。这是**检测算法**的备选（逐条比对 vs Merkle 链），不是处理策略的备选；当前选 Merkle 链因更简洁。
**备选：中段损伤也补缺失段（而非全量重置）。** 否决，三层理由：
1. **不可区分插入 vs 编辑**：Merkle 前缀链只能输出"前缀失配"，不能区分失配是因为"中段插入了新内容"（外部 provider 轮次插在链中间）还是"中段改写了已有内容"（编辑/重生成）。两种情况检测输出完全相同，但正确处理方式不同。proxy 无法区分，不能假设是插入。
2. **编辑场景产生矛盾叠加**：若服务端旧链存 `[sys,u1,a1,u2,a2]`，客户端发 `[sys,u1,a1,u2',a2',u3]`（u2 被编辑成 u2'），硬补会让服务端历史变成 `[sys,u1,a1,u2,a2,"补充:u2'...",u3]`——原始 u2 与编辑后 u2' 两条矛盾的同一轮消息并存，比全量重置更糟。
3. **重排破坏时序因果**：即使能确定是"中段插入"，把插入内容从中间挪到尾部追加，会破坏消息间的时序/因果关系。若插入内容引用了前文、或后文引用了插入内容，重排后因果链断裂。

核心区别：尾部链分叉是"服务端**少了**一段尾部"（可补），中段损伤是"服务端存了**错误的**内容"（不可补，只能丢弃旧链重置）。CodeArts 协议只支持追加新消息，不支持编辑历史——这是硬约束。

### D3: 检测的排除条件 — 三类请求不参与

与现有 `shouldInject` 判定（`chat-request.ts:222-230`）的排除逻辑保持同构，避免回归：

- `isToolContinuation`（`extractToolResults` 非空）→ 走 tool 续传，`messages=[] + tool_result`
- `isSubAgentRequest`（`codearts.sub_agent` 存在）→ 走子代理，`subAgent_prompt` 承载上下文
- `callerProvidedParent`（客户端传了 `codearts.parent_message_id`）→ 信任调用方，增量续传

**理由**：这三类请求各自已有明确的上下文/续传机制，分叉检测的信号（"代理上次回复"）对它们无意义或冲突（tool 续传的消息数组为空，没有可比的前缀）。

### D4: 缺失段折叠格式 — 参考上下文 + 当前请求分离

新增 `foldMissingSegment(messages, suffixStart, maxChars)`（`chat-translate.ts` 新增，同文件直接调用模块私有的 `foldMessageSegment` 复用其 role 标记与工具文本化逻辑）。`suffixStart` 由 D2 分类结果提供：

- `messages[L]` 等于 `lastReply` 时，`suffixStart = L + 1`，避免把已由 `parent_message_id` 覆盖的 assistant 回复重复发送。
- `messages[L]` 不等于 `lastReply` 时，`suffixStart = L`，因为旧链边界后第一条就是服务端未知内容。

缺失段内容为 `messages[suffixStart..]`；其最后一条 user turn 单独作为 `[当前用户请求]`，之前的消息作为参考上下文折叠：

```
[以下为补传的历史对话上下文，仅作参考，非用户新请求]
[user #1]
<缺失段内第一条用户消息>
[assistant]
<对应回复>(若含 tool_calls 追加 "[调用工具: <name>(<arguments>)]")
[tool result: <name>]
<工具输出>
[user #2]
<…>
[当前用户请求]
<messages 里最后一段用户 turn 文本>
```

- 头部 hint 与 `[当前用户请求]` 是新增的**辅助提示词模板**（可配置项 `MISSING_CONTEXT_HINT`，默认即上述文本），把"补传参考"与"当前要回答的请求"语义分离，缓解文本化带来的语义漂移。
- 缺失段 = `messages[suffixStart..]`，不是固定的 `messages[L..]`：当 `messages[L]` 已是 `lastReply` 时从 `L + 1` 开始，避免 parent 链与补发文本重复；当 `messages[L]` 不是 `lastReply` 时从 `L` 开始。
- 截断：整体超阈值时**新增 `truncateMissingSegment`**（不复用 `truncateFolded`——后者的锚点是 `[system]` / `[user #1]`，缺失段场景的锚点是头部 hint + 尾部 `[当前用户请求]`，直接复用会把 hint 当非锚点裁掉）。`truncateMissingSegment` 策略：保留头部 hint + 尾部 `[当前用户请求]` 段，贪心保留最新缺失轮次，裁剪中部。缺失段场景不需要保留头部 system 锚点，因为旧链已含它。
- 与 `foldFullConversation` 的区别：后者折叠"全部历史 + `[continuation]` 指令"，前者折叠"缺失尾部 + 参考 hint + 当前请求"。

**备选 A：复用 `foldFullConversation` 直接传整条。** 否决：语义不同——全量折叠需要 `[continuation]` 接续指令，补发需要"参考上下文 + 当前请求"分离，混用会削弱指令效果。
**备选 B：把缺失段也塞进 `task_parameters.contexts` / `projectLevelPrompt`。** 否决：`contexts` 抓包恒为 `[]` 且服务端行为未验证，语义错位。

### D5: 状态更新与失败回退

- **成功轮同步更新链状态**：`chat-stream.ts:364` 与 `chat.ts:142` 的 `setLastResponseMessageId` 处，同步写 `prefixChain / prefixLen / lastReplyHash`。
  - **链始终记客户端原始 `messages` 的链，不是实际发送的折叠文本的链**。无论本轮是正常续传、末尾补发还是全量重置，`prefixChain` / `prefixLen` 都基于客户端传入的 `request.messages` 重新计算，`lastReplyHash` 取代理返回给客户端的 assistant 消息哈希。这样下一轮分叉检测比对的基准始终是"客户端历史"，而非"代理发送的折叠文本"。
  - `lastReply` 取**代理构建并返回给客户端的 assistant 消息**（`chat-stream.ts` 用 `delta` 累积、`chat.ts:166` 用 message 构造），以 `normalizeForChain` 哈希存。
  - **"成功"判定**：流式路径 = `!sseHadError && responseMetadata.response_message_id`（与现有 `setLastResponseMessageId` 的守卫一致）；非流式路径 = `responseMetadata.response_message_id` 存在且未抛异常（`chat.ts` 无 `sseHadError` 等价变量，靠未 throw 隐含成功）。
- **`forceResync` 参数语义**：给 `buildRequestBody` 增加可选第三参数 `opts?: { forceResync?: boolean }`。`forceResync: true` 的契约 = **跳过分叉检测，强制走中段损伤分支**（`parent_message_id=""` + `foldFullConversation`）。这是补发失败回退的唯一目标，不应有其他歧义语义。`forceResync: false` / 未传 = 正常分叉检测流程。
- **末尾补发失败回退全量重置**：这是**新增独立分支**，不是复用现有 rate-limit retry。触发条件 = `divergence === "tail-divergence" && (上游 HTTP 非 200 || SSE error_code 非成功)`。在 `chat-stream.ts` 的错误处理路径中新增此分支：检测到补发请求失败时，用 `buildRequestBody(request, session, { forceResync: true })` 重建为全量重置请求并重发一次。失败仅重试一次，避免死循环。现有 rate-limit retry（`isRetryableSSEError`）保持不变，不与此分支混用。
- **非流式路径（`chat.ts`）的回退策略**：`chat.ts` 现有错误处理是直接 `throw`，无 retry 机制。补发失败回退在非流式路径的实现选择：**在 `chat.ts` 的 SSE error 处理处新增补发失败检测，若 `divergence === "tail-divergence"` 则用 `forceResync` 重建重发一次后再返回；若重发仍失败则抛错给客户端**。与非流式路径的现有语义一致（错误最终抛给上层），只是多一次内部重试机会。
- **工具续传轮的链状态更新**：工具续传请求（`isToolContinuation`）虽然**不参与分叉检测**（D3 排除），但其成功轮**仍按完整 `request.messages` 更新链状态**（`prefixChain` / `prefixLen` / `lastReplyHash`）。理由：客户端在工具续传时消息数组里通常携带完整历史 + 最新 tool 消息，若不更新链状态，下一轮正常用户请求会以旧链为基准，导致检测漂移。工具续传轮更新后，下一轮检测的"正常尾部"定义（见 D2）天然兼容 tool 消息位于 lastReply 之后。
- **链损坏自愈**：补发/重置轮若响应异常（无 `response_message_id`），链状态不更新，下一轮自然回到"无链"→ 冷启动全量注入，不会卡在坏状态。

### D6: 配置与文档

本次 change 共涉及 **5 个环境变量**，全部需写入 README 环境变量表：

| 环境变量 | 默认值 | 控制什么 | 所属 |
|---------|--------|---------|------|
| `CHAIN_DIVERGENCE_REPAIR_ENABLED` | `false` | 热链分叉检测与修复总开关 | 新增 |
| `MISSING_CONTEXT_HINT` | 中文模板（D4 头部 hint 文本） | 缺失段补发的辅助提示词模板 | 新增 |
| `FULL_CONTEXT_INJECTION_ENABLED` | `false` | 冷启动全量注入开关（Map miss） | 已有未记录 |
| `FULL_CONTEXT_MAX_CHARS` | `8000` | 折叠文本最大字符数 | 已有未记录 |
| `FULL_CONTEXT_MAX_CHARS_BY_MODEL` | `{}`（JSON map） | 按模型覆盖折叠阈值 | 已有未记录 |

- **两个 flag 的依赖关系**：`CHAIN_DIVERGENCE_REPAIR_ENABLED` 开启时，其内部的**中段损伤全量折叠**和**补发失败回退全量重置**分支**不受** `FULL_CONTEXT_INJECTION_ENABLED` 控制。理由：这两个分支是"热链修复"的组成部分，不是"冷启动注入"；若受 `FULL_CONTEXT_INJECTION_ENABLED` 约束，用户只开 `CHAIN_DIVERGENCE_REPAIR_ENABLED` 时中段损伤会静默退化为"只发最后一条 user message"（丢历史）。实现上，`buildRequestBody` 的中段损伤分支直接调用 `foldFullConversation`，不经过 `shouldInject` 的 `config.fullContextInjectionEnabled` 检查。`FULL_CONTEXT_INJECTION_ENABLED` 仅控制冷启动注入（Map miss）路径。
- **README 文档入口**：在 `README.md` 环境变量表补全这 5 条，并加 `FULL_CONTEXT_MAX_CHARS_BY_MODEL` JSON 示例（如 `{"GLM-5.2":500000,"openpangu-2.0-pro":180000}`），避免"变更未生效"的误判（spike §3 已实测 GLM-5.2 ~195K / pro ~104K / flash ~9K token 窗口）。
- `FULL_CONTEXT_INJECTION_ENABLED` / `FULL_CONTEXT_MAX_CHARS` / `FULL_CONTEXT_MAX_CHARS_BY_MODEL` 沿用；在 `README.md` 环境变量表补全三条并加 `FULL_CONTEXT_MAX_CHARS_BY_MODEL` 示例（如 `{"GLM-5.2":500000,"openpangu-2.0-pro":180000}`），避免"变更未生效"的误判（spike §3 已实测 GLM-5.2 ~195K / pro ~104K / flash ~9K token 窗口）。

## Risks / Trade-offs

- [末尾补发依赖"分叉前旧链在服务端仍有效"，不可验证] → D5 失败回退全量重置兜底；spike 1.4c 已证"复用旧 chat_id + parent 空"服务端不叠加，副作用可控
- [补发文本化造成语义漂移（模型把参考上下文当用户输入）] → D4 头部 hint + `[当前用户请求]` 分离，配置项可调模板
- [链哈希误判（外部轮次内容与 lastReply 恰好相同）] → 概率极低，接受;极端情况降级为错误分类 → 最坏是全量重置，不丢数据
- [Merkle 链计算 O(L) 每轮] → 单会话消息数有限（几十条量级），O(L) sha256 计算可忽略;TTL 4h 与现有机制一致
- [新增内存状态与 `lastResponseMessageId` 生命周期绑定] → 重启丢失，自然降级为冷启动注入（行为正确），与"最小有状态"设计一致
- [补发轮若被限流重试（`chat-stream.ts` 现有 retry 逻辑），`buildRequestBody` 纯函数重算会重复检测为补发] → 保持同输入同输出即可正确重试，无需特殊处理
- [热链修复生效前提：`chat_id` 稳定] → `chat_id` 由 `request.codearts.chat_id` 或 `deriveConversationId(system + 首条 user)` 派生。若客户端不传 `chat_id` 且切换 provider 时 system prompt 变化，`chat_id` 会不同，链状态 miss，降级为冷启动注入（行为正确但无热链优化收益）。热链修复仅在 `chat_id` 跨切换不变时生效——客户端传稳定 `chat_id`，或 `system + 首条 user` 在切换前后不变。

## Migration Plan

1. **标志位灰度**：拆分为独立开关（如 `CHAIN_DIVERGENCE_REPAIR_ENABLED`，默认 `false`），先不动默认行为;观察 `[proxy→codearts] REQUEST` 日志中的分类标记（tail-divergence / middle-damage / normal）
2. 灰度期在日志中记录分类结果与补发触发，比对真实场景命中率
3. 确认无误后默认开启（或由用户显式开启，按 README 文档化）
4. 回滚：关闭标志即回到现状（现有增量 + 冷启动注入），无需代码回退

## Open Questions

- 缺失段补发后，CodeArts 服务端如何把"补发文本"关联到 `parent_message_id` 指向的历史节点——**已于 2026-08-20 通过真实上游 spike 验证**：`parent_message_id` 非空 + 单条折叠缺失段文本可正常拼接，HTTP 200、无 `ChatAgent.*` 错误、返回新的 `response_message_id`，模型能按 `[当前用户请求]` 继续回答（首轮 prompt_tokens=3288，补发轮 prompt_tokens=3405）。保留失败回退作为运行时兜底。
- 是否给 `chain-divergence-detection` 单独加日志埋点（结构化字段 `divergence: "tail-divergence"|"middle-damage"|"normal"`）以便灰度观察——大概率要，但属实现细节，不阻塞 spec。
- `MISSING_CONTEXT_HINT` 模板文案是否需要中英文双语——先按项目惯例用中文，后续按需调整。