# Spike: Full-Context Injection on Cache Miss

本文档记录 `full-context-injection-on-cache-miss` 变更的 spike 验证结果：直接 POST 折叠注入请求到 CodeArts 上游，验证接受度、边界与恢复行为。

- **Spike 脚本**: `scripts/spike-full-context-injection.ts`（gitignore，不入库）
- **折叠样本**: `scripts/spike-fold-sample.ts`（含 `foldForSpike` + `buildLongToolOutput`）
- **测试日期**: 2026-08-18
- **账号**: futurelab_TJZH（OAuth 登录，session 2 小时过期）

## 1. 接受度结论

### 1.3 正常样本（786 字符折叠文本）

| 指标 | 值 |
|------|-----|
| HTTP 状态 | 200 ✅ |
| SSE 行数 | 21 |
| prompt_tokens | 3,784 |
| completion_tokens | 21 |
| error_code | "0" |
| respCode | 0 |
| 模型行为 | 生成 Read tool call，参数 `{"path":"D:\\projects\\demo\\src\\routes\\api.ts"}` —— **接续历史，未复述** |

**结论**: CodeArts 上游接受 D2 折叠格式的单条 text 注入，模型正确理解历史上下文并接续回答。

### 1.4 边界测试（含超长工具输出）

#### 1.4a 超长样本（9,204 字符，含 9,000 字符工具输出）

| 指标 | 值 |
|------|-----|
| HTTP 状态 | 200 ✅ |
| SSE 行数 | 217 |
| prompt_tokens | 6,656 |
| completion_tokens | 222 |
| error_code | "0" |
| 模型行为 | 正确识别 9,000 字符重复日志行模式，生成结构化总结（ERROR 0 条 / WARN 0 条 / INFO 全部 / 日志风暴结论） |

**结论**: 9K 字符折叠注入完全可行，模型能解析超长工具输出。

#### 1.4b Context window 边界（三模型梯度测试）

通过 `--size N` 参数构造 N 字符工具输出的折叠样本，二分查找上游 context window 边界。

| size (chars) | GLM-5.2 | openpangu-2.0-pro | openpangu-2.0-flash |
|------|------|------|------|
| 9,000 | ✅ 6,656t | — | ✅ 7,860t |
| 10,000 | — | — | ✅ 8,301t |
| 11,000 | — | — | ✅ 8,735t |
| 11,500 | — | — | ❌ ChatAgent.00001007 |
| 100,000 | ✅ 37,675t | ✅ 48,188t | ❌ |
| 200,000 | — | ✅ 92,497t | — |
| 220,000 | — | ✅ 101,356t | — |
| 225,000 | — | ✅ 103,579t | — |
| 230,000 | — | ❌ | — |
| 300,000 | ✅ 105,850t | ❌ | — |
| 500,000 | ✅ 174,035t | — | — |
| 550,000 | ✅ 191,078t | — | — |
| 560,000 | ✅ 194,492t | — | — |
| 570,000 | ❌ | — | — |
| 575,000 | ❌ | — | — |
| 600,000 | ❌ | — | — |
| 700,000 | ❌ | — | — |
| 900,000 | ❌ | — | — |
| 1,100,000 | ❌ | — | — |

**三模型 context window 边界**:

| 模型 | 字符边界 | token 边界 | tokens/char |
|------|---------|-----------|-------------|
| openpangu-2.0-flash | ~11K | **~9K** | ~0.78 |
| openpangu-2.0-pro | ~225K | **~104K** | ~0.46 |
| GLM-5.2 | ~560K | **~195K** | ~0.35 |

**错误形态**: HTTP 仍返回 200，但 SSE 只发 2 行就 `[DONE]`，带 `ChatAgent.00001007: The downstream service message format is incorrect`（下游推理服务拒绝，本质是超 context window）。

#### 1.4c 叠加测试（复用旧 chat_id + parent 为空）

1. 首轮：新 chat_id `220e941c...` + parent 空 → response_message_id `02eb0cd6...`，prompt_tokens 3,784
2. 复用同一 chat_id + parent 空 + 折叠注入 → HTTP 200，prompt_tokens 3,785，正常生成

**结论**: 复用旧 chat_id + parent 为空时，服务端**没有叠加旧历史**，而是把折叠注入当作新输入处理（prompt_tokens 与首轮几乎一致）。Risks 第 5 条的"历史重复叠加"风险**未发生** —— 服务端对"parent 为空"的处理是"无 parent 续传"而非"从 chat_id 首条续传"。

### 1.5 恢复测试（parent + reuse 续传）

用首轮的 response_message_id 作 parent，复用同一 chat_id 续传：

| 指标 | 值 |
|------|-----|
| HTTP 状态 | 200 ✅ |
| SSE 行数 | 36 |
| prompt_tokens | 4,182（比首轮 3,784 高 ~400，说明服务端加载了 parent 历史） |
| completion_tokens | 37 |
| error_code | "0" |
| response_message_id | 新值 `36678645...` |

**结论**: 注入轮后通过 `response_message_id` 正常回流增量协议。D5"一次性移植"设计成立 —— 注入轮返回的 `response_message_id` 可用于下一轮 parent 续传，服务端正确加载 parent 历史。

## 2. 折叠格式定稿建议（D2）

spike 验证 design.md D2 格式完全可行，**无需调整**：

```
[system]
<system 内容>

[user #1]
<第一条用户消息>

[assistant]
<回复内容>
[调用工具: <name>(<arguments>)]

[tool result: <tool_name>]
<工具输出>

[user #2]
<当前用户消息>

[continuation]
以下为历史对话上下文,请基于此继续响应最新用户请求。
```

- **role 标记**: `[system]`/`[user #N]`/`[assistant]`/`[tool result: name]` —— 模型正确解析
- **工具文本化**: `[调用工具: name(args)]` —— 模型识别工具调用历史
- **continuation 指令**: 末尾 `[continuation]` 段 —— 有效防止"复述历史"，模型接续而非复述
- **developer role**: 按 `[system]` 折叠（D2 约定）
- **未知 role**: 按 `[unknown: <role>]` 标记（D2 约定）

## 3. 截断阈值定稿建议（D3）

基于 context window 实测，**按模型动态配置**截断阈值：

| 模型 | 建议折叠文本软上限（chars） | 理由 |
|------|---------------------------|------|
| openpangu-2.0-flash | 8,000 | 窗口 ~9K tokens，留 ~1K 给生成 |
| openpangu-2.0-pro | 180,000 | 窗口 ~104K tokens，留 ~20K 给生成 |
| GLM-5.2 | 500,000 | 窗口 ~195K tokens，留 ~20K 给生成 |
| 默认（未知模型） | 8,000 | 保守，按最小窗口对齐 |

**单条工具结果截断**: 头部 2K + 尾部 2K + 中部 `[...truncated <original-length> chars...]` 标记（D3 边界 3）。

**配置项建议**:
- `FULL_CONTEXT_MAX_CHARS`: 默认 `8000`（保守，按 flash 窗口）
- `FULL_CONTEXT_INJECTION_ENABLED`: 默认 `false`（feature flag，灰度开启）
- 可选 `FULL_CONTEXT_MAX_CHARS_BY_MODEL`: 按模型覆盖（如 `{"GLM-5.2":500000,"openpangu-2.0-pro":180000}`）

## 4. 触发条件的经验修正（D1）

spike 未发现需要修正 D1 触发条件的情况。**D1 公式保持不变**:

```
注入触发 = NOT(客户端传了 codearts.parent_message_id)
        AND NOT(内存 Map 有 getLastResponseMessageId(chatId))
        AND NOT(sub-agent 请求)
        AND messages 历史长度 > 1
```

**叠加测试的经验补充**: 1.4c 显示"复用旧 chat_id + parent 为空"时服务端不叠加旧历史，因此 D1 中"客户端未传 parent"即触发注入是安全的 —— 不会导致历史重复叠加。

## 5. 模型理解质量评估

| 场景 | 模型行为 | 评估 |
|------|---------|------|
| 正常多轮历史（1.3） | 生成 Read tool call 接续历史 | ✅ 正确接续 |
| 超长工具输出（1.4a） | 识别重复模式，结构化总结 | ✅ 正确解析 |
| 超长日志（100K~560K） | 正确生成错误频率总结 | ✅ 正确解析 |
| parent 续传（1.5） | 基于 parent 历史续答 | ✅ 正确续传 |

**未观察到"复述历史"行为** —— `[continuation]` 指令段有效。

## 6. 风险更新

| 风险 | spike 结论 |
|------|-----------|
| CodeArts 对折叠注入的接受度 | ✅ **已验证可行**（正常 + 超长 + 三模型边界） |
| 长折叠文本触发上游长度错误 | ✅ **已量化**：GLM-5.2 ~195K / pro ~104K / flash ~9K tokens |
| 模型复述历史 | ✅ **未发生**，`[continuation]` 指令有效 |
| 复用旧 chat_id 历史叠加 | ✅ **未发生**，parent 为空时服务端不叠加 |
| 注入后回流增量协议 | ✅ **已验证**，response_message_id 正常返回可续传 |

## 7. 后续行动

- [x] Spike 验证完成（1.1-1.5）
- [x] 本结论文档（1.6）
- [ ] 定稿 D2/D3 并加配置项（Task 2.1/2.2）
- [ ] 实现 `foldFullConversation` + 注入分支（Task 3.1-3.4）
- [ ] 单元测试 + 集成冒烟 + 回归（Task 4.1-4.4）
- [ ] 收尾（Task 5.1-5.3）
