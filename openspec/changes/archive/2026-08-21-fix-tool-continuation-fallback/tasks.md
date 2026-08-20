## 1. 工具助手消息哈希规范化（P1，先做，边界判定依赖它）

- [x] 1.1 在 `normalizeForChain` 中对 `tool_calls[].type` 归一化：`null` / `undefined` / `""` 与字面 `"function"` 归一为同一值
- [x] 1.2 在 `normalizeForChain` 中对 `reasoning_content` 归一化：`null` / `undefined` / `""` 归一为同一值
- [x] 1.3 统一 `chat.ts` 与 `chat-stream.ts` 重建 `assistantMessage` 的字段规则：`reasoning_content` 两处一致的取值策略，`tool_calls[].type` 缺省补 `"function"`（仅作用于链状态重建，不改 `cleanToolCallDeltas` 对客户端输出）
- [x] 1.4 在 `chat-translate.test.ts` 新增 T1-T3：`normalizeForChain` 对 `tool_calls[].type` / `reasoning_content` 空值归一化、`arguments` 哈希区分（含 type 缺省 vs `"function"`、reasoning 空值差异场景）
- [x] 1.5 在 `chat-translate.test.ts` 新增 T4：`chat.ts` 风格（含 reasoning + type="function"）与 `chat-stream.ts` 风格（无 reasoning + type 缺省）两路径重建消息 `normalizeForChain` 相等
- [x] 1.6 在 `chat-request-context.test.ts` 新增 T5 集成链路：按重建规则构造 assistant(tool_calls) 并 `setChainState` → 下一轮请求携带客户端 echo（type 缺省）+ tool → 边界成立（suffixStart=prefixLen+1）判 tail-divergence；加末尾 user 判 normal

## 2. tail-divergence 纯工具段补发修复（P0）

- [x] 2.1 修改 `foldMissingSegment`：段内无 user 时不再返回空串，改为按工具段真实语义折叠（保留 assistant 工具调用文本与工具结果，复用既有 `foldMessageSegment` + `TOOL_RESULT_HEAD_TAIL_CHARS` / `truncateMissingSegment` 预算截断），不套用「当前用户请求」结构；适配 `truncateMissingSegment` 的 `current`/预算计算；**确保含 user 段的既有折叠结构（hint + segments + `[当前用户请求]`）保持不变**
- [x] 2.2 修改 `buildRequestBody` 的 tail-divergence 分支：兜底（不可达防御）不发送历史 user/system，返回空 messages 依赖 parent 推进或按 middle-damage 重置
- [x] 2.3 在 `chat-translate.test.ts` 新增 T6/T7：`foldMissingSegment` 对「无 user 段（assistant+tool）」与「纯 tool 段」返回非空、含工具语义标注、不含 `[当前用户请求]`；T13 折叠受预算约束
- [x] 2.4 在 `chat-request-context.test.ts` 新增 T8/T9：tail-divergence 纯工具段（边界不等 / 边界相等两种形态）修复体携带工具上下文、不含已确认 user/system、parent 保持
- [x] 2.5 在 `chat-request-context.test.ts` 补 T10：可追溯 tool + 末尾 user 仍判 normal；确认 T12（不可追溯 tool → middle-damage）既有用例保持绿；另修复 `classifyDivergence` 使「边界=lastReply + 仅可追溯 tool 尾段」判 tail-divergence 而非 middle-damage

## 3. 回归与验证

- [x] 3.1 运行 `chat-translate` / `chat-request-context` 相关单测，确保 T1-T13 全部通过
- [x] 3.2 运行完整 `npm test`（6 个串联文件）、`npm run lint`、`npm run build` 通过
- [ ] 3.3 本地起服务（DEBUG 日志开 body 级打印）用真实链路验证：连续工具调用轮次中，proxy 转发给上游的请求不再重复已确认的 user/system、工具结果可达上游
- [ ] 3.4 按模型窗口配置折叠上限验证：确认 `FULL_CONTEXT_MAX_CHARS_BY_MODEL`（GLM-5.2 按 196608 token 量级）下折叠不触顶上游 `ChatAgent` 报错

## 4. 会话级消息传递验证（真实链路 playbook，独立 chat_id 隔离）

- [ ] 4.1 扩展 `scripts/verify-warm-switch-context-real.ts`（或新增同风格脚本）实现 S1：正常多轮工具对贯穿（system→user→assistant(tc)→tool→user→…）——每轮返回新 `response_message_id`、日志 `divergence=normal`、后续轮上游能感知工具结果
- [ ] 4.2 实现 S2（核心回归）：在 CodeArts 上轮回复后插入外部轮次 → 只发 `[assistant(外部 tc), tool]` 无新 user —— body 含 `[调用工具:` 与 `[tool result:`、不含首条 user 内容、parent 复用旧节点、继续对话不再重复
- [ ] 4.3 实现 S3+S4：中段损伤重置后恢复增量；duplicate/stale 自动重置后可继续（修正历史脚本「期望拒绝」的过时断言）
- [ ] 4.4 实现 S5：冷启动新 chat_id 首轮全量注入/普通增量；S6：打断/取消后不脏写链状态、下次请求回退正常
- [x] 4.5 在单测补 T14-T20 传递通道正交用例：normal 纯 tool 合并、tool-continuation 旁路、caller-parent 旁路、sub-agent 旁路、duplicate 自动重置、冷启动无链状态（T16/T17/T18/T20 已实现并通过；T19 由既有用例覆盖；T14/T15 由 T10 等价覆盖）
