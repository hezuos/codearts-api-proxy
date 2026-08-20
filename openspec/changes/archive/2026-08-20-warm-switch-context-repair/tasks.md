## 1. Spike:验证"parent 非空 + 补发文本"的叠加行为

- [x] 1.1 编写 spike 脚本（复用 `scripts/signRequest`/`getCredentials` 工具链，gitignore）构造请求:先发一轮正常对话取得 `response_message_id`;然后复用同一 `chat_id` 以 `parent_message_id=<上轮id>` + `messages=[{type:"text",content:<折叠缺失段>}]` 再发一轮,观察服务端是否把 parent 链与补发文本正确拼接(而非叠加/互斥)
- [x] 1.2 记录并对比:prompt_tokens 增量、回复是否理解 parent 链内容 + 缺失段内容、是否报 `ChatAgent.*` 错误
- [x] 1.3 若实测"parent 非空 + 补发文本"行为异常,在 3.x 实现中把尾部断裂补发降级为"parent 空 + 缺失段折叠"或全量重置,并更新 design.md D4 备注

## 2. 链状态与分叉检测核心（src/upstream/huawei/chat-request.ts）

- [x] 2.1 新增链状态存储:单个 `Map<chat_id, ChainState>`（`ChainState = { prefixChain, prefixLen, lastReplyHash }`，与 `lastResponseMessageId`/`lastResponseMessageTs` 同 TTL 定时器清理,4h）。导出读写函数（如 `getChainState` / `setChainState`）。**在现有 `cleanupTimer` 回调里同步清理链状态 Map**（避免内存泄漏）。不用三个独立 Map 以避免同步不一致
- [x] 2.2 实现 Merkle 前缀链哈希辅助函数(可放 chat-translate.ts 导出):新建 `normalizeForChain(msg)`，纳入 `role`、规范化 `content`、`name`、`refusal`、`reasoning_content`、`tool_call_id`、tool_calls 的 `id/type/function.name/function.arguments`;tool_calls 按 `id` 排序后以固定字段顺序序列化（消除数组顺序敏感,避免不同工具调用被视为相同消息）。`computeChainHash(prevHash, msg)` = `sha256(prevHash | normalizeForChain(msg))`，并实现 `computeChainForMessages(messages)` 逐条累积返回最终链哈希与长度
- [x] 2.3 在 `buildRequestBody` 的 `!isToolContinuation` 分支内、现有 `shouldInject` 判定**之前**,增加分叉检测:D3 排除条件(工具续传/子代理/客户端传 parent)已在内层短路;对未排除请求,读取链状态并计算 `new[0..L)` 前缀比对 → 分三类(normal / tail-divergence / middle-damage)。**边界条件**:`N < L` → middle-damage；`N == L` 且前缀完全匹配 → duplicate/stale,不得再次调用 `extractUserMessage` 或向上游发送最后 user；`N > L` 时校验 `messages[L..]` 整个尾部:第一条规范化哈希 == `lastReplyHash` → `suffixStart=L+1`,否则 `suffixStart=L`;随后允许 0+ 条可追溯 tool 消息,最后恰一条 user 且无额外 assistant/user → normal;明确多轮/异常 → tail-divergence;无法确认 → middle-damage
- [x] 2.4 正常延续:保持现状增量续传(不动 `extractUserMessage` 与 parent 复用逻辑)
- [x] 2.5 中段损伤:走全量折叠重置分支(`foldFullConversation` + `parent_message_id=""`)。**此分支不受 `config.fullContextInjectionEnabled` 控制**（热链修复的组成部分，非冷启动注入），直接调用 `foldFullConversation`，不经过 `shouldInject` 检查。复用现有日志标记
- [x] 2.6 尾部链分叉:根据检测结果计算 `suffixStart` —— 若 `messages[L]` 等于 `lastReply` 则为 `L+1`（避免 parent 已覆盖的 assistant 重复发送）,否则为 `L`;新增补发分支:`messagesBody = [{type:"text", content: foldMissingSegment(messages, suffixStart, maxChars)}]`,`parent_message_id` 用 Map 旧节点;补发分支**不进入**现有"最后一条 tool 合并"逻辑(D6 协作)。缺失段含外部 provider 轮次与当前请求,最后一条 user 作为 `[当前用户请求]`
- [x] 2.7 为 `buildRequestBody` 增加可选第三参数 `opts?: { forceResync?: boolean }`。`forceResync: true` 的契约 = 跳过分叉检测，强制走中段损伤分支（`parent_message_id=""` + `foldFullConversation`）。供失败回退重建全量重置请求时覆盖分类结果
- [x] 2.8 在 `[proxy→codearts] REQUEST` 日志增加结构化分类字段:`divergence: "normal" | "tail-divergence" | "middle-damage"`,补发时附 `missingChars`、折叠段字符数、`fullResync` 标志;尾部无法确认降级为 middle-damage 时附 `unverifiableTail: true`

## 3. 缺失段折叠与辅助函数（src/upstream/huawei/chat-translate.ts）

- [x] 3.1 实现 `foldMissingSegment(messages, suffixStart, maxChars)` 纯函数:缺失段 = `messages[suffixStart..]`;若 `messages[L]` 等于 `lastReply`,由 `suffixStart=L+1` 排除已由 parent 覆盖的回复,否则从 L 开始;头部追加参考 hint(默认`MISSING_CONTEXT_HINT` 模板),最后一条 user turn 单独作 `[当前用户请求]` 配套内容,其余按 D2 折叠(同文件直接调用模块私有的 `foldMessageSegment` 复用 role 标记/工具文本化);缺失段为空返回空串
- [x] 3.2 截断策略:**新增 `truncateMissingSegment`**（不复用 `truncateFolded`——后者锚点是 `[system]`/`[user #1]`，缺失段场景锚点是头部 hint + 尾部 `[当前用户请求]`）。保留头部 hint + 尾部当前请求段，贪心保留最新缺失轮次，裁剪中部。缺失段场景无 system 锚点（旧链已含）
- [x] 3.3 导出 `computeChainForMessages` 等其他辅助函数(2.2 需要),新建 `normalizeForChain`（不复用 `normalizeMessageContent`，后者只处理 content），并入 role / tool_calls 的规范化（tool_calls 按 id 排序后序列化）
- [x] 3.4 在 `chat-translate.test.ts` 追加 `foldMissingSegment` 用例:(a) `suffixStart=L+1` 时不重复 lastReply;(b) `suffixStart=L` 时保留边界后的第一条未知消息;(c) 基本缺失段 → 含参考 hint 与 `[当前用户请求]`;(d) 缺失段含 tool 轮次 → 文本化正确;(e) 缺失段超阈值 → 保最新 + 当前请求;(f) `suffixStart` 越界/空尾部 → 返回合理结果;(g) `null` content → 不产生 "null" 字符串
- [x] 3.5 追加链哈希辅助函数用例:(a) 相同序列产生相同链哈希;(b) 任一消息变化(含 role/content/name/refusal/reasoning_content/tool_call_id/tool_calls id/type/name/arguments)导致链哈希不同;(c) tool_calls 仅改变数组顺序时链哈希相同;(d) 截断到 L 的前缀与完整链对应前缀一致

## 4. 状态更新与失败回退（src/upstream/huawei/chat-stream.ts + chat.ts）

- [x] 4.1 成功轮同步更新链状态:在 `chat-stream.ts:364` 与 `chat.ts:142` 的 `setLastResponseMessageId` 处,依据本次请求的客户端 messages + 返回的 assistant 内容,更新 `prefixChain/prefixLen/lastReplyHash`。**链始终记客户端原始 `request.messages` 的链**（不是实际发送的折叠文本的链），`lastReplyHash` 取本轮新返回的 assistant 消息（工具续传请求也一样,不能继续记录之前的 assistant tool-call 消息）。这样下一轮分叉检测的基准始终是"客户端历史"
- [x] 4.2 计算 `lastReplyHash`:并记录本次代理返回给客户端的 assistant 回复规范化哈希(流式用累积 delta 内容,非流式用 `chat.ts:166` 的 message 构造)
- [x] 4.3 错误轮不更新链状态(`sseHadError` 时与现有 `lastResponseMessageId` 的行为一致)
- [x] 4.4 尾部链分叉补发失败回退:**新增独立分支**（不是复用现有 rate-limit retry）。触发条件 = `divergence==="tail-divergence" && (上游 HTTP 非 200 || SSE error_code 非成功)`。在 `chat-stream.ts` 错误处理路径中检测到此条件时,用 `buildRequestBody(request, session, { forceResync: true })` 重建为全量重置请求并重发一次(复用 `chat-stream.ts` 现有的 httpsPost 重发时机),失败仅重试一次并记日志。现有 `isRetryableSSEError` rate-limit retry 保持不变,不与此分支混用
- [x] 4.5 非流式路径(`chat.ts`)补发失败回退:在 `chat.ts` 的 SSE error 处理处新增补发失败检测,若 `divergence==="tail-divergence"` 则用 `forceResync` 重建重发一次后再返回;若重发仍失败则抛错给客户端（与现有非流式语义一致,只多一次内部重试机会）
- [x] 4.6 工具续传轮链状态更新:工具续传请求(`isToolContinuation`)成功轮**也按完整 `request.messages` 更新链状态**(prefixChain/prefixLen/lastReplyHash),避免下一轮正常检测基准漂移（详见 design D5）

## 5. 配置与文档

- [x] 5.1 `src/config.ts` 新增 `MISSING_CONTEXT_HINT` 配置项(默认 D4 模板文本);新增 `CHAIN_DIVERGENCE_REPAIR_ENABLED` feature flag(默认 `false`),与 `FULL_CONTEXT_INJECTION_ENABLED` 并列。**依赖关系**:`CHAIN_DIVERGENCE_REPAIR_ENABLED` 开启时,中段损伤全量折叠和补发失败回退全量重置不受 `FULL_CONTEXT_INJECTION_ENABLED` 控制（热链修复组成部分,非冷启动注入）
- [x] 5.2 `README.md` 环境变量表补全五条（照此措辞）:
  - `FULL_CONTEXT_INJECTION_ENABLED` | `false` | 冷启动全量注入开关:Map 未命中时折叠完整历史注入而非只发最后一条
  - `FULL_CONTEXT_MAX_CHARS` | `8000` | 折叠文本最大字符数（保守对齐 openpangu-2.0-flash ~9K token 窗口）
  - `FULL_CONTEXT_MAX_CHARS_BY_MODEL` | `{}` | 按模型覆盖折叠阈值,JSON 格式,如 `{"GLM-5.2":500000,"openpangu-2.0-pro":180000}`
  - `CHAIN_DIVERGENCE_REPAIR_ENABLED` | `false` | 热链分叉检测与修复开关:切换 provider 后检测上下文分叉,尾缺补发/中缺重置
  - `MISSING_CONTEXT_HINT` | 中文模板 | 缺失段补发的辅助提示词模板:标记"补传历史仅作参考"与"当前用户请求"
  并注明两个 flag 的依赖关系:仅开 `CHAIN_DIVERGENCE_REPAIR_ENABLED` 时,中段损伤全量折叠与补发失败回退全量重置不受 `FULL_CONTEXT_INJECTION_ENABLED` 控制
- [x] 5.3 `docs/codearts-api-spec.md` 3.3.x 补记"热链分叉检测与末尾补发"请求形态(头部 hint + `[当前用户请求]` 折叠、parent 复用、分级策略),标注 spike 验证结论
- [x] 5.4 更新 `AGENTS.md`(新增热链分叉约定与 feature flag 说明)

## 6. 测试与回归验证

- [x] 6.1 分叉检测单元测试(新建或追加 `chat-translate.test.ts` / 独立 `chat-request` 测试):覆盖 (a) 前缀一致 + 尾部为合法单轮延续(最后回复+tool*+单user) → normal;(b) 前缀一致 + 尾部含完整外部轮次(`[lastReply, extUser, extAsst, curUser]`) → tail-divergence,`suffixStart=L+1`;(c) 前缀一致 + 尾部第一条不是 lastReply → tail-divergence,`suffixStart=L`;(d) 前缀一致 + 尾部含多个 user 轮次/额外 assistant → tail-divergence;(e) 前缀一致 + 尾部 tool 无法追溯 → 归入 middle-damage(无法确认兜底);(f) 前缀失配 → middle-damage;(g) 工具续传/子代理/客户端传 parent → 不参与检测,但工具续传成功后更新链状态;(h) 单轮历史 / 空 messages → 不触发;(i) 链状态缺失(重启) → 冷启动注入;(j) `N < L` → middle-damage;(k) `N == L` 且前缀匹配 → duplicate/stale,不重复发送最后 user;(l) 只开 `CHAIN_DIVERGENCE_REPAIR_ENABLED` 不开 `FULL_CONTEXT_INJECTION_ENABLED` 时中段损伤仍全量折叠（不静默丢历史）
- [x] 6.2 单元测试全部通过:`pnpm test`
- [x] 6.3 类型检查与 lint:`pnpm run build` + `pnpm run lint` 全绿
- [x] 6.4 集成冒烟:开启 flag 后经 proxy 走一轮"模拟尾部链分叉"请求(构造带外部 provider 轮次的历史),验证上游正常返回、日志含 `divergence:"tail-divergence"`,且后续轮恢复增量续传
- [x] 6.5 回归:flag 关闭时与现状完全一致(增量 + 冷启动注入行为零回归);工具续传、子代理路径不受影响

## 7. 收尾

- [x] 7.1 清理 spike 临时脚本(或按仓库惯例归档)
- [x] 7.2 全绿后合入变更,sync 主 specs(chain-divergence-detection 新建、full-context-injection 与 codearts-request-forwarding 走 delta 合并)