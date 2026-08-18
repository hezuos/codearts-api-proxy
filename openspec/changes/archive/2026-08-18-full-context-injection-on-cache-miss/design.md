## Context

现状(见 proposal.md — Why):`buildRequestBody`(`src/upstream/huawei/chat-request.ts`)在非工具续传时只调用 `extractUserMessage`(`src/upstream/huawei/chat-translate.ts:48`)取最后一段非 assistant/tool 消息作为上游 `messages`。这在缓存命中(增量续传)时正确;缓存未命中时 CodeArts 服务端无上下文,只剩最后一段,对话失忆。CodeArts 协议约束:`messages` 元素为 `{type:"text",content}` 且**无 role 字段**(docs/codearts-api-spec.md 3.3.1),工具结果只能经 `task_parameters.tool_result` 传递且须匹配 CodeArts 自己发出的 `toolCallId`。

## Goals / Non-Goals

**Goals:**
- 缓存未命中时,把完整对话历史折叠为单条 `text` 注入上游,作为一次性"上下文移植"
- 保持缓存命中时的增量协议行为**完全不变**,零回归
- 注入后下一轮通过 `response_message_id` 自然回流增量协议
- 通过 spike 验证 CodeArts 对折叠注入的接受度,再定稿折叠格式与阈值

**Non-Goals:**
- 不改变 CodeArts 协议本身的 messages 结构(不做多元素/role 字段尝试)
- 不做 proxy 侧长期的会话历史持久化(那是另一个变更域,见 Open Questions)
- 不处理"工具续传 + 缓存未命中"的完整恢复(仅告警,行为与现状一致)
- 不修复 `lastResponseMessageId` 内存 Map 重启丢失问题(与本次注入判定正交)

## Decisions

### D1: 注入判定条件 — "缓存未命中"的精确定义

```
注入触发 = NOT(客户端传了 codearts.parent_message_id)
        AND NOT(内存 Map 有 getLastResponseMessageId(chatId))
        AND NOT(sub-agent 请求 request.codearts.sub_agent 存在)   ← 见 D1.1
        AND messages 历史长度 > 1(超过当前轮)
```

**理由**:三种信号各自独立。客户端显式传 parent 说明调用方自己管续传 → 增量;内存 Map 有记录说明 proxy 曾成功完成该 chat_id 的上一轮 → 服务端概率上有历史 → 增量。两者皆无且历史多于一轮 → 服务端大概率无上下文 → 注入。
**备选**:仅凭"内存 Map 未命中"触发。否决:跨 provider 首来时 chat_id 是全新派生,Map 必然未命中,该启发式与"历史长度"信号等价,但历史长度能区分"真迁移"与"首次冷启动只问了第一句"。

**实现提示**:判定"客户端是否传了 parent"应检查 `request.codearts?.parent_message_id` 是否非空,**不是** `chat-request.ts:187` 的 `parentMessageId` 局部变量 —— 后者会被 `getLastResponseMessageId(chatId)` 填充,Map 命中时 `parentMessageId` 非空但客户端并未传 parent。按 D1 公式应分别检查两个信号源:`request.codearts?.parent_message_id`（客户端信号）与 `getLastResponseMessageId(chatId)`（Map 信号）,两者皆空且 `messages.length > 1` 且非 sub-agent 才触发注入。

### D1.1: 子代理(sub-agent)请求不注入

`buildRequestBody` 对 subAgent 请求同样走 `extractUserMessage` 构建 messages,但**注入判定显式排除 sub-agent**:子代理有自己的 `subAgent_prompt` 上下文,注入完整主对话历史既超长又不必要,还可能与该 chat_id 的 role-collision 检测(chat-request.ts:166-185)叠加产生噪音。

**理由**:子代理的上下文职责由 `subAgent_prompt` 承载;把主对话历史折叠注入会破坏子代理的独立性,且子代理任务(如 Explore/规格代理)通常只需要当前任务说明,不需要全部主对话。保持现状(增量最后一段)即为正确行为。
**备选**:子代理也注入。否决:与子代理设计语义冲突,无明显收益。

**边界:子代理 + tool 续传组合**:若 sub-agent 请求最后一条是 `role:"tool"` 消息,`chat-request.ts:156-157,201` 的 `isToolContinuation` 判定优先成立,`messagesBody = []`,根本不进入注入判定或合并逻辑。此为**现有行为**(非本次变更引入),本设计不改变 —— sub-agent 的 toolCallId 归属由子代理自身的上游轮次管理,与主对话的 `lastResponseMessageId` Map 正交。极端边缘场景,spike 不专门覆盖。

### D2: 折叠格式 — 带 role 标记的单条 text

采用**带回车分隔的 role 前缀标记**纯文本,形如:

```
[system]
<system 内容>

[user #1]
<第一条用户消息>

[assistant]
<回复内容>(若含 tool_calls,追加 "[调用工具: <name>(<arguments>)]")

[user #2]
<第二条用户消息>

[tool result: <tool_name>]
<工具输出>

[user #3]
<当前用户消息>

[continuation]
以下为历史对话上下文,请基于此继续响应最新用户请求。
```

**理由**:CodeArts messages 无 role 字段,必须把语义编码进文本;方括号标记是极小侵入、人类可读、模型易解析的约定;`CodeArts` 侧无特殊处理,服务端按普通文本接收。末尾的 `[continuation]` 指令段帮助模型区分"历史回放"与"当前任务",降低"复述历史"风险(见 Risks 第 3 条)。
**role 覆盖**:`developer` 角色(openai.ts:48 类型)按 `system` 处理,折叠为 `[system]` 段;未知 role(如 `function`)折叠为 `[unknown: <role>]` 文本标记,避免产生无标记裸文本。
**备选 A:多元素 text 数组** — messages 传多个 `{type:"text"}`。否决:未获抓包证据,服务端可能把每元素都当"用户输入"拼接,行为不可预测。
**备选 B:塞进 `projectLevelPrompt`/`contexts`** — 语义错位(`projectLevelPrompt` 是系统提示,`contexts` 抓包恒为 `[]`),且会污染系统提示字段,否决。

### D3: 截断策略 — 保留头部 + 尾部,裁剪中部

阈值用**字符数**(对齐上游 text 处理,估算简单位),默认值待 spike 确定,配置项保留(如 `FULL_CONTEXT_MAX_CHARS`,默认 `8000`):

```
保留:system + 第一条 user(对话锚点)
裁剪:中间轮次(按"轮"为单位整段丢弃,保证语义完整)
保留:最近 N 轮直到字符阈值
```

**理由**:跨 provider 迁移时最需要"当时在聊什么"的近期上下文 + 系统性锚点;裁剪按轮不按字符切段,避免半截消息破坏可读性。
**备选**:按最大消息条数截断。否决:工具结果可能单条就超长(如命令输出),条数不能约束字节占用;字符阈值直接对冲上游文本长度限制。

**边界定义**(实现与测试须覆盖):
1. **system + 第一条 user 本身超阈值**:system 始终保留(锚点不可丢);第一条 user 截断到 `阈值 - len(system) - 标记开销` 的剩余预算,尾部追加 `[...truncated...]` 标记;若剩余预算 ≤ 0,第一条 user 仅保留该标记(即 system 独占阈值)。
2. **最近 N 轮累加策略**:从最新轮往回逐轮累加字符数,累加到阈值即停 —— 即"贪心保留最新"。不预先固定 N,而是由字符阈值动态决定保留几轮。
3. **工具结果单条超阈值**:不整条丢弃(会丢工具语义),保留头部 2k + 尾部 2k 字符,中间用 `[...truncated <original-length> chars...]` 标记,使模型仍能感知"有工具调用且输出很长"。
4. **空 messages 或无 user 消息**:折叠函数返回空字符串;调用方(`buildRequestBody` 注入分支)收到空字符串时回退到 `extractUserMessage` 现有行为,避免上游收到空 `messages`。

### D4: 工具轮次文本化 — 不进 tool_result

OpenAI 侧历史里的 `tool_calls`/`tool` 消息**折叠为文本标记**(见 D2 格式),绝不映射到 `task_parameters.tool_result`。`tool_result` 只留给**能确认 toolCallId 为 CodeArts 所发**的路径 —— 即缓存命中(调用方提供 parent 或 Map 有 `lastResponseMessageId`)且最后一条是工具消息的现有逻辑。缓存未命中时无法静态判断 toolCallId 是否 upstream-known(内存 Map 已丢),一律保守折叠文本化,并告警。

**理由**:`tool_result` 要求 `toolCallId` 匹配 CodeArts 自己发出的调用;跨 provider 历史中的工具调用 ID 是 OpenAI 侧的,CodeArts 无法匹配,上报会触发 `ChatAgent.00009999`/`ChatAgent.00001208` 类错误(chat-translate.ts 注释已记载)。文本化是唯一安全表达。缓存未命中时"未知调用 ID"与"已知 OpenAI 侧 ID"在可验证性上等价(都不可匹配),因此统一走文本化。

**告警约定**:文本化时输出 `logger.warn("tool continuation folded: upstream continuity unavailable", { chat_id, toolCallId, toolName })`,字段对齐 `chat-request.ts:172` 的 `CHAT_ID COLLISION` 告警风格(结构化对象 + chat_id)。告警仅记日志,不向客户端响应注入信号(客户端无需感知折叠与否)。

**工具区分**:折叠函数**不区分内置/非内置工具,统一文本化**。内置/非内置的区分(`isCodeArtsBuiltinTool`)只在 `tool_result` 路径(缓存命中,`extractToolResults` 第 87 行过滤)有意义 —— 非内置工具在 `tool_result` 路径被过滤后由 `chat-request.ts:200-220` 合并逻辑拼进用户消息。折叠路径全部走文本,不复刻该过滤逻辑,避免不必要的分支。

### D4.1: 折叠的 content 规范化约束

折叠历史中每条消息的 `content` 必须经 `normalizeMessageContent`(chat-translate.ts:29)规范化后再拼接:该函数已处理 `string | null`（openai.ts:49 的 `OpenAIChatMessage.content` 实际类型）；实现上还防御性处理了数组/多模态形态（第 32-44 行），即便未来类型放宽也安全。直接 `typeof === "string"` 拼接会在 `null` content 时产生 `"null"` 字符串、在数组 content 时产生 `[object Object]` 之类的坏文本。`system`/`user`/`assistant` 与 `tool` 消息的规范化走同一入口,保证格式统一。

### D5: 注入后的回流 — 一次性移植

注入轮正常走现有 SSE 解析,`response_message_id` 照常写入内存 Map(`setLastResponseMessageId`)。下一轮自动缓存命中 → 增量协议。无需特殊状态机。

### D6: 注入分支与现有 tool-content 合并逻辑的协作

`chat-request.ts:200-220` 的 `messagesBody` 构建段在**非工具续传**路径里有一段现有逻辑:当最后一条消息是 `role:"tool"` 时,把 tool content 合并到 `extractUserMessage` 结果里拼成 `[工具执行结果]` 文本。注入分支启用时必须**跳过**这段合并逻辑 —— 折叠函数(D2/D4)已经把 tool 消息文本化进折叠结果,若再跑合并逻辑会产生重复文本或覆盖折叠结果。

**实现约定**:`buildRequestBody` 里注入判定(D1)必须在 `!isToolContinuation` 分支**内部**,作为该分支的第一个子判定 —— 这样工具续传请求在 `chat-request.ts:201` 的 `isToolContinuation` 判定处就分流为 `messagesBody = []`,根本不进入注入判定,tasks 3.2 的"工具续传路径不受影响"才成立。注入判定成立且 flag 开启时,`messagesBody` 直接赋值为 `[{ type: "text", content: foldFullConversation(messages, maxChars) }]`,**不进入** `chat-request.ts:200-220` 的 `if (lastMsg?.role === "tool")` 合并分支。折叠函数返回空字符串时(见 D3 边界 4),回退到现有 `extractUserMessage` + 合并逻辑,保持现状行为。

## Risks / Trade-offs

- [CodeArts 对"新 chat_id + 超长折叠单条 text"的接受度**未经任何抓包验证**(所有样本 msgs=1 且短)] → **最高优先级 spike**:手工构造折叠请求实测响应,验证通过再定稿格式与阈值
- [长折叠文本可能触发上游长度/格式错误] → D3 截断阈值 + spike 中测试超长边界;若服务端收窄限制,调小默认值
- [服务端把折叠文本当"用户当前输入"导致回复风格怪异(如复述历史)] → 折叠格式标注明确("以下为历史对话,请基于此继续"),spike 中观察回复质量;若不可接受,退回"注入后下一轮人工提示"或改投 `projectLevelPrompt`
- [折叠格式未来与 CodeArts 官方格式变化冲突] → 格式与阈值集中在一个模块(`foldFullConversation`)并配单元测试,便于后续对齐
- [内存 Map 未命中误判:proxy 重启后 CodeArts 服务端历史仍在,注入导致历史重复叠加] → 注入是"新会话首条 + parent 为空"形态,服务端若真有关联历史,行为未知;spike 增加"复用旧 chat_id + 无 parent"用例验证;风险可接受(跨 provider 主场景 chat_id 全新,无叠加)
- **[现有已知局限,不在本 change 范围]缓存命中但客户端历史被窗口裁剪**:opencode 类客户端可能按窗口裁剪历史,此时 Map 命中旧 parent,增量续传会从旧 parent 继续但客户端新消息已丢失被裁剪的上下文段。本 change 的注入判定只在"缓存未命中"触发,不处理此场景 —— 保持现有行为,仅记录此局限,避免实现者误以为本 change 覆盖了它。

## Migration Plan

1. 先做 spike(手工构造折叠请求打上游,验证接受度)→ 定稿 D2/D3 的白话格式与默认阈值
2. 实现 `foldFullConversation` 与注入分支,默认**关闭**(feature flag,如 `FULL_CONTEXT_INJECTION_ENABLED=false`),灰度开启
3. 开启后观察日志(`[proxy→codearts] REQUEST` messagesCount/注入标记)+ 客户端反馈
4. 回滚:关闭 flag 即回到现状行为,无需代码回退

## Open Questions

- 是否需要 proxy 侧会话历史持久化(`lastResponseMessageId` Map 落盘)作为注入的长效替代?—— 独立变更域,不影响本设计(注入逻辑与持久化可共存)
- 折叠注入是否要包含"系统提示(system)"本身?跨 provider 场景下 opencode 的 system prompt 含会话/session 信息,折叠进首段文本有助于锚定,但可能泄露 provider 内部提示结构 —— 待 spike 观感后决定,不影响 D2 框架
- CodeArts 对折叠文本的模型理解质量(能否正确"接续"而非"复述")只能靠实测评估,无法静态定论