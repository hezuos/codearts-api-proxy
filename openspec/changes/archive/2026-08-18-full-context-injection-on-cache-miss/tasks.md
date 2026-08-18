## 1. Spike:验证 CodeArts 对折叠注入的接受度

- [x] 1.1 依据 design.md D2 的折叠格式,手工构造一份含 system + 多轮 user/assistant + 工具轮次的折叠文本(实际对话样本,如从 `scripts/captured-requests/` 提取一段多轮历史)
- [x] 1.2 复用现有签名/认证工具(`signRequest`/`getCredentials`),写一个临时脚本(`scripts/spike-full-context-injection.ts`,gitignore)直接 POST 到 `/v1/chat/chat`,请求体为:`chat_id`(新造 32 位 hex)+ `messages=[{type:"text",content:<折叠文本>}]` + `parent_message_id:""` + 常规 task_parameters(可复制 captured-request-4.json 的模板,**复制后清洗 user_id / auth / session 相关字段,仅保留结构骨架**,避免真实身份信息进 git)
- [x] 1.3 观察并记录响应:HTTP 状态、SSE 事件流、是否报 `ChatAgent.*` 错误码、是否正常生成回答
- [x] 1.4 边界测试:折叠文本含长工具输出(>8k 字符)与正常长度各一发;测试"复用旧 chat_id + parent 为空"的叠加行为(design.md Risks 第 5 条,**旧 chat_id 来自 spike 首轮创建的会话:先发一轮正常请求记录返回的 chat_id + response_message_id,然后重置 parent 为空、复用同一 chat_id 再发折叠注入,观察服务端是否叠加历史**)
- [x] 1.5 恢复测试:在 spike 中用返回的 `response_message_id` 发第二轮(增量续传),确认注入后能正常回流增量协议
- [x] 1.6 产出 spike 结论文档(`docs/spike-full-context-injection.md`):接受度结论、折叠格式定稿建议、截断阈值定稿建议、触发条件的经验修正

## 2. 定稿折叠格式与截断阈值

- [x] 2.1 根据 spike 结论定稿 D2 折叠格式(role 标记、工具轮次文本化、是否含 system prompt)
- [x] 2.2 根据 spike 结论定稿 D3 截断默认阈值,并在 `src/config.ts` 添加配置项(如 `FULL_CONTEXT_MAX_CHARS`,默认值以 spike 为准;`FULL_CONTEXT_INJECTION_ENABLED` 默认 `false`)

## 3. 核心实现

- [x] 3.1 在 `src/upstream/huawei/chat-translate.ts` 新增 `foldFullConversation(messages, maxChars)` 纯函数:按 design.md D2/D3 折叠历史、按轮截断、返回单条 text content;**新建** `src/upstream/huawei/chat-translate.test.ts`(仓库当前无此文件,测试为手动串联式,风格对齐 `chat.test.ts`),并**将新测试文件追加到 `package.json` 的 `test` 脚本末尾**(在 `huawei-auth.test.ts` 之后,避免 `&&` 串联时本文件失败掩盖后续);3.1 测试覆盖**折叠函数的核心格式与截断逻辑**(role 标记、工具文本化、超阈值裁剪),4.1 负责补充**边界与畸形输入用例**(空历史、单轮、全 assistant 等),两者职责不重叠
- [x] 3.2 在 `chat-request.ts` 的 `buildRequestBody` 增加注入分支:判定条件(design.md D1)成立且 flag 开启时,`messages` 使用折叠结果替代 `extractUserMessage`;工具续传路径(`tool_result`)不受影响
- [x] 3.3 注入分支日志:在 `[proxy→codearts] REQUEST` 增加注入标记(如 `fullContextInjected:true`、折叠后字符数),便于灰度观察
- [x] 3.4 确保 `deriveConversationId` 在注入场景仍派生出可复用的 chat_id(注入轮后 `response_message_id` 正常写入 Map,下一轮回流增量)

## 4. 测试与验证

- [x] 4.1 单元测试:折叠函数的纯逻辑边界用例,覆盖:(a) 空历史 `messages=[]` → 返回空字符串;(b) 仅单轮历史(只一条 user) → 返回该 user 内容(不触发注入,但函数须正确处理);(c) 全 assistant 消息(无 user) → 返回空字符串;(d) 全 tool 消息(无 user/assistant) → 返回空字符串或纯工具标记;(e) `system + 单 user`(最常见冷启动) → 正常折叠;(f) `null` content 消息 → 不产生 `"null"` 字符串;(g) 超长单条工具结果 → 触发 D3 边界 3 的头尾保留 + 中部截断标记;(h) system + 第一条 user 合计超阈值 → 触发 D3 边界 1 的 system 保留 + user 截断。每个用例断言折叠结果的结构与关键标记存在性
- [x] 4.2 集成冒烟:开启 flag 后经 proxy 走一轮"多历史注入"请求,验证上游正常返回且日志含注入标记;同时验证**流式(`streamHuaweiChatToResponse`)与非流式(`sendHuaweiChatRequest`)两条路径**(两 handler 共用 `buildRequestBody`,均须冒烟)
- [x] 4.3 回归:确认 flag 关闭时行为与现状完全一致(增量场景零回归);确认工具续传、子代理路径不受影响—— 子代理请求**永不注入**(design D1.1),即便缓存未命中
- [x] 4.4 更新 `docs/codearts-api-spec.md`:补记"折叠注入"请求形态与限制(基于 spike 实测)

## 5. 收尾

- [x] 5.1 清理 spike 临时脚本与手工构造的请求样本(或按仓库惯例归档)
- [x] 5.2 更新 `AGENTS.md`(如折叠功能成为新的已知约定)与相关文档
- [x] 5.3 经 `pnpm run build` + `pnpm test` + `pnpm run lint` 全绿后,合入变更