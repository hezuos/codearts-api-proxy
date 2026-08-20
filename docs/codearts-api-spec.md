# CodeArts IDE Agent HTTP 接口规范文档

> 基于 35 个抓包样本逆向分析，时间范围：2026-04-16T06:54 ~ 09:08

---

## 1. 接口 URL 规律

### 1.1 Endpoint

```
POST https://snap-access.cn-north-4.myhuaweicloud.com/v1/chat/chat
```

> **注意**：抓包中 `method` 字段显示为 `GET`，但从 body 有实体内容及语义判断，实际应为 `POST`（可能是抓包工具记录有误，或底层 HTTP/2 语义问题）。

### 1.2 路径结构

| 段       | 值                                         | 说明                              |
| -------- | ------------------------------------------ | --------------------------------- |
| 域名     | `snap-access.cn-north-4.myhuaweicloud.com` | 华为云固定域名（cn-north-4 区域） |
| 版本前缀 | `/v1`                                      | API 版本，固定                    |
| 资源路径 | `/chat/chat`                               | 固定路径，无 path 参数            |

### 1.3 Query 参数

所有 35 个样本中均无 Query 参数，参数全部通过 Request Body 传递。

---

## 2. 请求 Headers

### 2.1 观察结果

**所有抓包文件的 `headers` 字段均为空对象 `{}`**，表明抓包脚本未能捕获到 HTTP 请求头（可能在 TLS 握手完成后的底层捕获）。

### 2.2 推断必须头（根据华为云 API 惯例）

| Header          | 说明                              | 示例/格式                                                         |
| --------------- | --------------------------------- | ----------------------------------------------------------------- |
| `Content-Type`  | 请求体类型                        | `application/json`                                                |
| `X-Sdk-Date`    | 请求时间戳（HMAC 签名用）         | `20260416T065423Z`（UTC，格式 `yyyyMMddTHHmmssZ`）                |
| `Authorization` | HMAC-SHA256 签名鉴权              | `SDK-HMAC-SHA256 Access=<AK>, SignedHeaders=..., Signature=<sig>` |
| `X-Project-Id`  | 华为云项目 ID（可选，多项目场景） | 32 位十六进制字符串                                               |

### 2.3 鉴权方式（华为云 AK/SK 签名）

华为云标准 HmacSHA256 签名流程（与 AWS Signature V4 类似）：

```
StringToSign = "SDK-HMAC-SHA256\n" + Timestamp + "\n" + Hex(SHA256(CanonicalRequest))
Signature    = Hex(HMAC-SHA256(SecretKey, StringToSign))
Authorization: SDK-HMAC-SHA256 Access=<AccessKey>, SignedHeaders=content-type;host;x-sdk-date, Signature=<Signature>
```

---

## 3. 请求 Body 完整字段结构

### 3.1 顶层字段

```json
{
  "chat_id": "string",
  "messages": [],
  "client": "IDE",
  "task": "plan-execute",
  "task_parameters": { ... },
  "batch_task_parameters": [],
  "attempt": 1,
  "user_id": "string",
  "agent_id": "CodeAgent",
  "parent_message_id": "string",
  "is_delta_response": true,
  "model_id": "string"
}
```

| 字段                    | 类型    | 变化规律                    | 说明                                               |
| ----------------------- | ------- | --------------------------- | -------------------------------------------------- |
| `chat_id`               | string  | 同一会话内固定，新对话更换  | 会话唯一 ID，32 位十六进制（无连字符）             |
| `messages`              | array   | 每次请求变化                | 用户新消息；tool_result 续传时为空数组 `[]`        |
| `client`                | string  | **固定值** `"IDE"`          | 客户端类型标识                                     |
| `task`                  | string  | **固定值** `"plan-execute"` | 任务类型                                           |
| `task_parameters`       | object  | 部分字段变化                | 见 3.2 节                                          |
| `batch_task_parameters` | array   | **固定值** `[]`             | 批量任务参数，始终为空数组                         |
| `attempt`               | integer | **固定值** `1`              | 重试次数（均为 1，未观察到其他值）                 |
| `user_id`               | string  |  `"steertech"`    | 用户 ID（根据登陆的用户变化）                            |
| `agent_id`              | string  | **固定值** `"CodeAgent"`    | Agent 类型标识                                     |
| `parent_message_id`     | string  | 每次请求变化                | 续传凭证，见第 5 节；新对话首条消息为空字符串 `""` |
| `is_delta_response`     | boolean | **固定值** `true`           | 始终为 `true`，表示流式响应                        |
| `model_id`              | string  | 按会话/请求变化             | 所用模型，见下表                                   |

**观察到的 `model_id` 值：**

| 值                   | 出现场景                           |
| -------------------- | ---------------------------------- |
| `"Glm-4.7-internal"` | 早期请求（chat_id=dbd28...）       |
| `"Glm-5-internal"`   | 中期请求（chat_id=559ae...，part） |
| `"deepseek-v3.2"`    | 中期请求（chat_id=559ae...，part） |
| `"GLM-5.1"`          | SubAgent 请求（chat_id=12453...）  |

---

### 3.2 `task_parameters` 子字段

#### 3.2.1 通用字段（所有请求均存在）

| 字段                      | 类型    | 变化规律                               | 说明                              |
| ------------------------- | ------- | -------------------------------------- | --------------------------------- |
| `preferred_language`      | string  | **固定值** `"zh-cn"`                   | 响应语言偏好                      |
| `enable_code_interpreter` | boolean | **固定值** `false`                     | 是否启用代码解释器                |
| `projectLevelPrompt`      | string  | **固定值** `""`                        | 项目级系统提示，通常为空          |
| `isSubAgent`              | boolean | 变化                                   | `false`=主 Agent，`true`=子 Agent |
| `tools`                   | array   | 固定（SubAgent 较少）                  | 可用工具定义列表，见 3.4 节       |
| `environmentDetails`      | object  | `currentDate` 每次变化                 | 运行环境信息，见 3.2.2            |
| `routerVersion`           | string  | **固定值** `"v2"`                      | 路由版本                          |
| `isNewClient`             | boolean | **固定值** `true`                      | 新版客户端标识                    |
| `features`                | object  | **固定值** `{"support_end_tag": true}` | 功能特性声明                      |
| `contexts`                | array   | **固定值** `[]`                        | 上下文附件，始终为空              |
| `expert_rules`            | array   | **固定值** `[]`                        | 专家规则，始终为空                |
| `ide`                     | string  | **固定值** `"CodeArts Agent"`          | IDE 标识                          |

#### 3.2.2 `environmentDetails` 对象

```json
{
  "osVersion": "win32",
  "currentDate": "2026-04-16T14:54:23.000182",
  "currentWorkingDirectory": "d:\\xLight\\Documents\\Projects\\pyqt"
}
```

| 字段                      | 类型   | 变化规律             | 说明                                 |
| ------------------------- | ------ | -------------------- | ------------------------------------ |
| `osVersion`               | string | **固定值** `"win32"` | 操作系统                             |
| `currentDate`             | string | 每次请求变化         | 请求时的本地时间（ISO 8601，含微秒） |
| `currentWorkingDirectory` | string | 同工程       | 当前工作目录绝对路径                 |

#### 3.2.3 用户新消息时的专属字段

| 字段                    | 类型    | 说明                                             |
| ----------------------- | ------- | ------------------------------------------------ |
| `codebase_search`       | boolean | 是否启用代码库搜索，通常 `false`                 |
| `is_intent_recognition` | boolean | 是否启用意图识别（仅部分请求含此字段，`false`）  |
| `W3_Search`             | boolean | 是否启用 Web 搜索（仅部分请求含此字段，`false`） |
| `related_question`      | boolean | 是否生成相关问题（仅部分请求含此字段，`false`）  |

#### 3.2.4 Tool Result 续传时的专属字段

当 `messages` 为空、需要传递工具执行结果时，`task_parameters` 额外包含：

```json
{
  "tool_result": [
    {
      "feedback": "",
      "result": "...工具执行输出...",
      "name": "Bash",
      "arguments": {
        "command": "ls -la",
        "description": "列出当前目录内容"
      },
      "status": "APPROVE",
      "executeStatus": "success",
      "toolCallId": "call_ab2a96b58d1a45cfb13d5bc3"
    }
  ]
}
```

**`tool_result` 数组元素字段：**

| 字段            | 类型   | 说明                                                          |
| --------------- | ------ | ------------------------------------------------------------- |
| `feedback`      | string | 用户反馈，通常为空字符串 `""`                                 |
| `result`        | string | 工具执行的输出内容（可以很长）                                |
| `name`          | string | 工具名称，如 `"Bash"`、`"Read"`、`"Glob"`                     |
| `arguments`     | object | 原始工具调用参数（键值对，与工具定义对应）                    |
| `status`        | string | 用户审批状态，观察值为 `"APPROVE"`                            |
| `executeStatus` | string | 执行结果状态，观察值为 `"success"`                            |
| `toolCallId`    | string | 对应 AI 响应中的 tool*call ID（`call*` 前缀 + 24 位十六进制） |

#### 3.2.5 SubAgent 专属字段

当 `isSubAgent: true` 时额外包含：

| 字段              | 类型   | 说明                              |
| ----------------- | ------ | --------------------------------- |
| `subAgent_type`   | string | 子 Agent 类型，如 `"Explore"`     |
| `subAgent_prompt` | string | 子 Agent 附加提示，通常为空字符串 |

---

### 3.3 `messages` 字段结构

#### 3.3.1 用户新消息（`messages.length > 0`）

```json
[
  {
    "type": "text",
    "content": "用户输入的消息内容"
  }
]
```

| 字段      | 类型   | 说明                                   |
| --------- | ------ | -------------------------------------- |
| `type`    | string | 消息类型，观察到唯一值为 `"text"`      |
| `content` | string | 消息文本内容，可包含 Unicode、多行文本 |

#### 3.3.2 Tool Result 续传（`messages.length == 0`）

当传递工具执行结果时，`messages` 为空数组 `[]`，工具结果通过 `task_parameters.tool_result` 传递。

#### 3.3.3 全量上下文折叠注入（`messages.length == 1`，缓存未命中场景）

当 proxy 缓存未命中（客户端未传 `codearts.parent_message_id` 且内存 Map 无该 `chat_id` 的 `lastResponseMessageId`）、非子代理请求、且客户端历史多于一轮时，proxy 将完整对话历史折叠为单条 `text` 消息注入上游 `messages`，替代默认的"只取最后一段用户消息"行为。由 `FULL_CONTEXT_INJECTION_ENABLED` 环境变量控制（默认 `false`）。

折叠格式（带 role 标记的纯文本，design D2）：

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

**字段与限制：**
- `messages` 仍为单元素数组 `[{type:"text",content:<折叠文本>}]`，不改变 CodeArts 协议结构
- `parent_message_id` 为空字符串 `""`（新会话首条形态）
- role 标记：`system`/`developer` → `[system]`；`user` → `[user #N]`；`assistant` → `[assistant]`；`tool` → `[tool result: <name>]`；未知 role → `[unknown: <role>]`
- 工具轮次（`tool_calls`/`tool` 消息）折叠为文本标记，**不**映射到 `task_parameters.tool_result`（跨 provider 工具调用 ID 无法匹配 CodeArts 所发）
- 截断阈值 `FULL_CONTEXT_MAX_CHARS`（默认 8000）：超阈值时保留 system + 第一条 user（锚点）+ 贪心保留最新轮次，裁剪中部；单条工具结果超阈值时保留头 2K + 尾 2K + 中部截断标记
- 注入轮后 `response_message_id` 正常写入内存 Map，下一轮自动缓存命中 → 增量续传（一次性"上下文移植"）
- 子代理请求**永不注入**（由 `subAgent_prompt` 承载上下文）
- 工具续传路径不受影响（`isToolContinuation` 优先分流，`messages=[]` + `task_parameters.tool_result`）

---

#### 3.3.4 热链分叉修复（`CHAIN_DIVERGENCE_REPAIR_ENABLED=true`）

当 proxy 已有该 `chat_id` 的链状态且客户端未提供 `codearts.parent_message_id` 时，proxy 会校验客户端历史前缀和完整尾部结构：

- 正常单轮尾部（`lastReply + tool* + 当前 user`）→ 继续增量发送当前 user
- 尾部链分叉（切换 provider 后出现额外 user/assistant 轮次）→ 复用旧 `parent_message_id`，只追加折叠后的缺失尾部
- 中段损伤或尾部无法确认 → `parent_message_id=""`，全量折叠重置
- 若 `messages[L]` 已是旧的 `lastReply`，补发从 `L+1` 开始，避免重复发送 parent 已覆盖的 assistant；否则从 `L` 开始
- `N == L` 且历史完全相同视为重复/陈旧请求，不重复发送最后一条 user

尾部补发格式：

```
[以下为补传的历史对话上下文，仅作参考，非用户新请求]
<缺失尾部的 role 标记文本>

[当前用户请求]
<最新 user 内容>
```

尾部补发复用旧 `chat_id` 和 `parent_message_id`，失败时最多回退全量折叠重置一次。该行为由 `CHAIN_DIVERGENCE_REPAIR_ENABLED` 控制；热链修复中的全量回退不受 `FULL_CONTEXT_INJECTION_ENABLED` 控制。

相关配置：`CHAIN_DIVERGENCE_REPAIR_ENABLED`、`MISSING_CONTEXT_HINT`、`FULL_CONTEXT_MAX_CHARS`、`FULL_CONTEXT_MAX_CHARS_BY_MODEL`。

每个工具的完整格式：

```json
{
  "type": "function",
  "function": {
    "name": "ToolName",
    "description": "工具说明文本...",
    "parameters": {
      "type": "object",
      "properties": { ... },
      "required": ["field1", "field2"],
      "additionalProperties": false
    }
  }
}
```

#### 3.4.1 主 Agent 可用工具列表（12 个）

| 序号 | 工具名                  | 必填参数                                        | 说明                                                                                                |
| ---- | ----------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1    | `Task`                  | `description`, `prompt`, `subagent_type`        | 启动子 Agent 执行复杂任务                                                                           |
| 2    | `Bash`                  | `command`                                       | 执行 shell 命令（可选：`timeout`, `description`, `run_in_background`, `dangerouslyDisableSandbox`） |
| 3    | `Glob`                  | `pattern`                                       | 文件模式匹配（可选：`path`）                                                                        |
| 4    | `Grep`                  | `pattern`, `output_mode`, `multiline`, `i`, `n` | 内容搜索（可选：`path`, `glob`, `head_limit`, `type`, `A`, `B`, `C`）                               |
| 5    | `Read`                  | `file_path`                                     | 读取文件（可选：`offset`, `limit`）                                                                 |
| 6    | `Edit`                  | `file_path`, `old_string`, `new_string`         | 编辑文件（可选：`replace_all`）                                                                     |
| 7    | `Write`                 | `file_path`, `content`                          | 写入文件                                                                                            |
| 8    | `TodoWrite`             | `todos`                                         | 写入 TODO 列表                                                                                      |
| 9    | `ask_followup_question` | （无必填）                                      | 向用户提问（`question`, `options`, `minItems`, `maxItems`）                                         |
| 10   | `openBrowserInIDE`      | `url`                                           | 在 IDE 中打开浏览器                                                                                 |
| 11   | `SkillTool`             | `skill_name`                                    | 加载指定技能                                                                                        |
| 12   | `analyzeImage`          | `imageId`, `task`                               | 分析图片（可选：`regions`）                                                                         |

#### 3.4.2 SubAgent（Explore 类型）可用工具（5 个）

`Bash`, `Glob`, `Grep`, `Read`, `openBrowserInIDE`（只读操作子集）

---

## 4. 响应结构

### 4.1 HTTP 响应基础

**注意**：所有抓包文件均为请求侧记录，未包含响应 body。以下分析基于字段命名惯例和上下文推断（`is_delta_response: true`、`parent_message_id` 的续传机制等）。

### 4.2 推断的 SSE 响应格式

基于请求体中 `is_delta_response: true` 和 `parent_message_id` 续传机制，响应为 **Server-Sent Events (SSE)** 流式格式：

```
Content-Type: text/event-stream
```

每个 SSE 数据块格式：

```
event: <event_type>
data: <json_payload>

```

### 4.3 推断的 SSE Event 类型

根据 `parent_message_id`（每轮响应完成后更新）和 `toolCallId`（格式 `call_<24位十六进制>`）的使用，推断如下 event 类型：

#### `meta` — 元数据事件（响应开始时）

```json
{
  "chat_id": "dbd288a0324741db978311cca685846b",
  "response_message_id": "acf8fe49886b42f293594b77c033e16f",
  "request_message_id": "..."
}
```

> `response_message_id` 即为下一轮请求的 `parent_message_id`

#### `content_block_delta` — 文本流式内容

```json
{
  "delta": {
    "type": "text_delta",
    "text": "部分文本内容..."
  }
}
```

#### `message_delta` — 工具调用

```json
{
  "delta": {
    "type": "tool_use",
    "tool_calls": [
      {
        "id": "call_ab2a96b58d1a45cfb13d5bc3",
        "type": "function",
        "function": {
          "name": "Bash",
          "arguments": "{\"command\":\"ls -la\",\"description\":\"列出当前目录内容\"}"
        }
      }
    ]
  }
}
```

> `tool_calls[].id` 即为续传时 `tool_result[].toolCallId` 的来源

#### `message_stop` — 响应结束标志

```json
{
  "stop_reason": "end_turn"
}
```

---

## 5. 会话续传机制

### 5.1 整体机制

```
[客户端] → 请求1（parent_message_id=""，新对话）
                ↓
[服务端] → SSE响应（meta event包含 response_message_id="abc123"）
                ↓
[AI] → 决定调用工具（message_delta中含 tool_calls[].id="call_xyz"）
                ↓
[客户端] → 执行工具 → 得到结果
                ↓
[客户端] → 请求2（parent_message_id="abc123"，messages=[]，tool_result=[{toolCallId:"call_xyz",...}]）
                ↓
[服务端] → SSE响应（meta event包含新的 response_message_id="def456"）
                ↓
[客户端] → 请求3（parent_message_id="def456"，用户下一条消息）
```

### 5.2 新对话 vs 续传对话

| 特征                          | 新对话首条消息                      | 续传（工具结果）                 | 续传（新用户消息）                  |
| ----------------------------- | ----------------------------------- | -------------------------------- | ----------------------------------- |
| `parent_message_id`           | `""` (空字符串)                     | 上轮响应的 `response_message_id` | 上轮响应的 `response_message_id`    |
| `messages`                    | `[{"type":"text","content":"..."}]` | `[]` (空数组)                    | `[{"type":"text","content":"..."}]` |
| `task_parameters.tool_result` | 不存在                              | 存在（含工具执行结果）           | 不存在                              |
| `chat_id`                     | 新生成（新会话）或沿用              | 与当前会话相同                   | 与当前会话相同                      |

### 5.3 `parent_message_id` 来源

- **来源**：上一轮服务端 SSE 响应中 `meta` event 的 `response_message_id` 字段
- **格式**：32 位十六进制字符串（无连字符），如 `"acf8fe49886b42f293594b77c033e16f"`
- **首次请求**：空字符串 `""`（如 captured-request-4.json、captured-request-5.json）
- **注意**：captured-request-17.json（SubAgent 首次请求）的 `parent_message_id` 字段在 JSON 中缺失（`undefined`），与主 Agent 首条为 `""` 略有不同

### 5.4 Tool Result 续传的 `toolCallId` 来源

`tool_result[].toolCallId` = 上轮 AI 响应中 `tool_calls[].id`（即 `call_<24位十六进制>`）

---

## 6. 错误响应格式

抓包文件中无错误响应样本，根据华为云 API 惯例，错误响应为：

```json
{
  "error": {
    "code": "XXX.XXXX",
    "message": "错误描述",
    "details": []
  }
}
```

HTTP 状态码：

- `400` — 请求参数错误
- `401` — 鉴权失败
- `403` — 无权限
- `429` — 请求频率超限
- `500` — 服务内部错误

---

## 7. 跨请求变化规律总结

### 7.1 固定不变的字段

| 字段路径                                                     | 固定值                              |
| ------------------------------------------------------------ | ----------------------------------- |
| `client`                                                     | `"IDE"`                             |
| `task`                                                       | `"plan-execute"`                    |
| `agent_id`                                                   | `"CodeAgent"`                       |
| `is_delta_response`                                          | `true`                              |
| `attempt`                                                    | `1`                                 |
| `batch_task_parameters`                                      | `[]`                                |
| `user_id`                                                    | `"steertech"`（用户相关，实际可变） |
| `task_parameters.preferred_language`                         | `"zh-cn"`                           |
| `task_parameters.enable_code_interpreter`                    | `false`                             |
| `task_parameters.projectLevelPrompt`                         | `""`                                |
| `task_parameters.routerVersion`                              | `"v2"`                              |
| `task_parameters.isNewClient`                                | `true`                              |
| `task_parameters.features`                                   | `{"support_end_tag": true}`         |
| `task_parameters.contexts`                                   | `[]`                                |
| `task_parameters.expert_rules`                               | `[]`                                |
| `task_parameters.ide`                                        | `"CodeArts Agent"`                  |
| `task_parameters.environmentDetails.osVersion`               | `"win32"`                           |
| `task_parameters.environmentDetails.currentWorkingDirectory` | 同工程固定                          |

### 7.2 每次请求变化的字段

| 字段路径                                         | 变化说明                                           |
| ------------------------------------------------ | -------------------------------------------------- |
| `parent_message_id`                              | 每轮请求不同，来自上轮响应的 `response_message_id` |
| `model_id`                                       | 按会话或服务端路由变化（4 种不同模型）             |
| `task_parameters.environmentDetails.currentDate` | 每次请求时的实时时间戳                             |
| `messages[].content`                             | 用户每次输入不同                                   |
| `task_parameters.tool_result`                    | 仅续传时存在，内容取决于工具执行结果               |

### 7.3 同一会话内固定，新会话更换的字段

| 字段路径  | 说明                               |
| --------- | ---------------------------------- |
| `chat_id` | 会话 UUID（32 位十六进制无连字符） |

### 7.4 可选字段（部分请求出现）

| 字段路径                                | 出现条件                            |
| --------------------------------------- | ----------------------------------- |
| `task_parameters.codebase_search`       | 用户消息请求（非 tool_result 续传） |
| `task_parameters.is_intent_recognition` | 部分用户消息请求（后期版本）        |
| `task_parameters.W3_Search`             | 部分用户消息请求（后期版本）        |
| `task_parameters.related_question`      | 部分用户消息请求（后期版本）        |
| `task_parameters.tool_result`           | 仅 tool 执行结果续传时              |
| `task_parameters.subAgent_type`         | 仅 `isSubAgent: true` 时            |
| `task_parameters.subAgent_prompt`       | 仅 SubAgent 首次请求时              |

---

## 附录：完整请求 Body 示例

### A. 用户新消息（新对话）

```json
{
  "chat_id": "559aeb4041fd4f3cbc2ed85e563291c3",
  "messages": [{ "type": "text", "content": "4\n" }],
  "client": "IDE",
  "task": "plan-execute",
  "task_parameters": {
    "codebase_search": false,
    "preferred_language": "zh-cn",
    "enable_code_interpreter": false,
    "projectLevelPrompt": "",
    "isSubAgent": false,
    "tools": [],
    "environmentDetails": {
      "osVersion": "win32",
      "currentDate": "2026-04-16T14:57:57.000630",
      "currentWorkingDirectory": "d:\\xLight\\Documents\\Projects\\pyqt"
    },
    "routerVersion": "v2",
    "isNewClient": true,
    "features": { "support_end_tag": true },
    "contexts": [],
    "expert_rules": [],
    "ide": "CodeArts Agent"
  },
  "batch_task_parameters": [],
  "attempt": 1,
  "user_id": "steertech",
  "agent_id": "CodeAgent",
  "parent_message_id": "",
  "is_delta_response": true,
  "model_id": "Glm-4.7-internal"
}
```

### B. Tool Result 续传

```json
{
  "chat_id": "559aeb4041fd4f3cbc2ed85e563291c3",
  "messages": [],
  "client": "IDE",
  "task": "plan-execute",
  "task_parameters": {
    "tool_result": [
      {
        "feedback": "",
        "result": "Get-ChildItem : 找不到...",
        "name": "Bash",
        "arguments": { "command": "ls -la", "description": "列出当前目录内容" },
        "status": "APPROVE",
        "executeStatus": "success",
        "toolCallId": "call_ab2a96b58d1a45cfb13d5bc3"
      }
    ],
    "preferred_language": "zh-cn",
    "enable_code_interpreter": false,
    "projectLevelPrompt": "",
    "isSubAgent": false,
    "tools": [],
    "environmentDetails": {
      "osVersion": "win32",
      "currentDate": "2026-04-16T16:49:36.000654",
      "currentWorkingDirectory": "d:\\xLight\\Documents\\Projects\\pyqt"
    },
    "routerVersion": "v2",
    "isNewClient": true,
    "features": { "support_end_tag": true },
    "contexts": [],
    "expert_rules": [],
    "ide": "CodeArts Agent"
  },
  "batch_task_parameters": [],
  "attempt": 1,
  "user_id": "steertech",
  "agent_id": "CodeAgent",
  "parent_message_id": "f408f528e75b4462b2e21985d3474263",
  "is_delta_response": true,
  "model_id": "Glm-5-internal"
}
```

### C. SubAgent 请求

```json
{
  "chat_id": "124532fe27754a128a4b8e3e6d424407",
  "messages": [{ "type": "text", "content": "请全面探索..." }],
  "client": "IDE",
  "task": "plan-execute",
  "task_parameters": {
    "isSubAgent": true,
    "subAgent_type": "Explore",
    "subAgent_prompt": "",
    "preferred_language": "zh-cn",
    "enable_code_interpreter": false,
    "projectLevelPrompt": "",
    "tools": [],
    "environmentDetails": {
      "osVersion": "win32",
      "currentDate": "2026-04-16T17:08:12.000000",
      "currentWorkingDirectory": "d:\\xLight\\Documents\\Projects\\pyqt"
    },
    "routerVersion": "v2",
    "isNewClient": true,
    "features": { "support_end_tag": true },
    "contexts": [],
    "expert_rules": [],
    "ide": "CodeArts Agent"
  },
  "batch_task_parameters": [],
  "attempt": 1,
  "user_id": "steertech",
  "agent_id": "CodeAgent",
  "parent_message_id": "",
  "is_delta_response": true,
  "model_id": "GLM-5.1"
}
```
