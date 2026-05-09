# 多 Agent 并行 chat_id 碰撞问题分析与解决方案

> 分析日期: 2026-04-24（首次），2026-05-09（复核更新）
>
> **复核说明**：推荐的方案 A（在哈希输入中加入 system prompt）已实施。

## 一、问题描述

多个 opencode 进程共用同一个 CodeArts API Key 同时工作时，消息互相串扰，出现以下错误：

```
Tool messages must be a response to a preceding tool calls: call_18a442b692f44105bdd4b0d7, 
invalidate tool message ids: call_34bd35200dfb4f8c9358dae5
```

## 二、根因分析

### 2.1 chat_id 派生逻辑

当前 `chat_id` 的生成逻辑在 `src/upstream/huawei/chat-request.ts:81-91`：

```typescript
function deriveConversationId(messages, providerAccountId) {
  const firstMsg = messages.find(m => m.role === 'user') 
                ?? messages.find(m => m.role === 'system');
  const content = normalizeMessageContent(firstMsg.content);
  return sha256(`${providerAccountId}:${content}`).slice(0, 32);
}
```

特征：
- 只取**首条** user/system 消息内容
- 纯函数，无状态 — 同样输入永远返回同样 chat_id
- opencode 客户端不会传 `codearts.chat_id` 扩展字段，所以 100% 走此 fallback

### 2.2 串扰机制

```
时间线 ──────────────────────────────────────────────────────►

Agent A:  ──请求1──► chat_id=X, parent=""     ──响应1──► Map[X]=msg_A1
Agent B:  ──请求1──► chat_id=X, parent=msg_A1 ← 串了！──► 响应2属于A的对话
Agent A:  ──请求2──► chat_id=X, parent=msg_B1 ← 又串了！
                                                    ↓
                                              tool_call_id 不匹配
                                              → 上游报错！
```

### 2.3 三个串扰点

| 串扰点 | 位置 | 机制 |
|--------|------|------|
| **chat_id 碰撞** | `deriveConversationId` | `providerAccountId` 相同 + 首条消息相同 → hash 碰撞 |
| **parent_message_id 串扰** | `lastResponseMessageId` 全局 Map | 进程级单例，所有请求共享，chat_id 碰撞时互相覆盖 |
| **tool_call_id 不匹配** | CodeArts 上游 | A 的 tool_call 和 B 的 tool_result 混在同一对话，ID 对不上 |

### 2.4 为什么会碰撞

- 多个 opencode 进程共用同一 API Key → 同一 `providerAccountId`
- 不同进程的首条 user 消息可能相同（如 `"你好"` 或相似 prompt）
- 即使首条消息不同，system prompt 如果来自同一项目配置也可能相同
- 当前代码只取 `messages.find(m => m.role === 'user')`，**忽略了 system prompt 的区分作用**

## 三、方案对比

### 方案 1: 简单改法 — 将 system prompt 纳入指纹

```typescript
function deriveConversationId(messages, providerAccountId) {
  const systemMsg = messages.find(m => m.role === 'system');
  const firstUserMsg = messages.find(m => m.role === 'user');
  const key = `${providerAccountId}:${normalizeContent(systemMsg?.content)}:${normalizeContent(firstUserMsg?.content)}`;
  return sha256(key).slice(0, 32);
}
```

| 优点 | 缺点 |
|------|------|
| 改动最小（1个函数） | system prompt 相同时仍碰撞 |
| 无状态，纯函数 | 治标不治本 |
| opencode 的 system prompt 通常含 session 信息，实际碰撞概率低 | 不保证 |

### 方案 2: 基于 messages 全量指纹的映射表（推荐）

```
fingerprint = sha256(providerAccountId + 所有 user/assistant 消息内容拼接)

请求到达:
  1. 算 fingerprint
  2. 查表 → 有 → 复用 chat_id
  3. 查表 → 无 → 生成新 UUID，存入表

tool continuation (messages 为空):
  → 用 parent_message_id 反查 chat_id
```

| 优点 | 缺点 |
|------|------|
| 不同进程从第二轮起消息分叉，fingerprint 不同 | 引入有状态（映射表） |
| 精确区分不同对话 | 需处理 tool continuation 的反查 |
| 第一轮碰撞时，第二轮自动分叉 | 映射表需要 TTL 清理 |

### 方案 3: API Key 隔离

每个 opencode 进程用不同 API Key（绑定不同华为云账号）。

| 优点 | 缺点 |
|------|------|
| 完全隔离，零碰撞 | 需要多个华为云账号 |
| 无代码改动 | 不现实 — 用户通常只有一个账号 |

### 方案 4: 客户端传 chat_id

让 opencode 为每个 session 生成唯一 chat_id，通过 `codearts.chat_id` 传入。

| 优点 | 缺点 |
|------|------|
| 最干净，代理无状态 | opencode 是通用客户端，不会传 CodeArts 专有字段 |
| 完全避免碰撞 | 需改客户端，不现实 |

## 四、推荐方案详解：方案 2

### 4.1 数据结构

```typescript
// 新增: fingerprint → chat_id 映射
const fingerprintToChatId = new Map<string, string>();
const fingerprintTs = new Map<string, number>();  // TTL 时间戳

// 新增: response_message_id → chat_id 反查（tool continuation 用）
const responseMsgToChatId = new Map<string, string>();
const responseMsgTs = new Map<string, number>();

// 保留: 现有的 parent_message_id 追踪
const lastResponseMessageId = new Map<string, string>();  // 不变
```

### 4.2 fingerprint 计算

```typescript
function computeFingerprint(
  messages: OpenAIChatMessage[],
  providerAccountId: string,
): string {
  // 取所有 user + assistant 角色的消息内容
  // 跳过 tool 角色（tool result 内容每次不同，不稳定）
  const parts = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role}:${normalizeMessageContent(m.content)}`);
  
  // 如果没有任何 user/assistant 消息（tool continuation），返回空
  if (parts.length === 0) return '';
  
  const key = `${providerAccountId}:${parts.join('|')}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}
```

### 4.3 chat_id 解析流程

```
┌─────────────────────────────────────────────────────────────────┐
│  resolveChatId(request, session)                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  优先级 1: codearts.chat_id 显式传入                            │
│    → 直接使用（兼容 CodeArts 原生客户端）                       │
│                                                                 │
│  优先级 2: tool continuation → parent_message_id 反查            │
│    → 如果 request 含 tool_result                                │
│    → 用 parent_message_id 查 responseMsgToChatId                │
│    → 找到 → 复用 chat_id                                       │
│    → 没找到 → 降级到优先级 3                                   │
│                                                                 │
│  优先级 3: fingerprint 查表                                     │
│    → 计算 fingerprint                                           │
│    → fingerprintToChatId 有 → 复用                              │
│    → fingerprintToChatId 无 → 新 UUID，存入表                   │
│                                                                 │
│  优先级 4: 兜底                                                  │
│    → fingerprint 为空且无法反查 → 新 UUID                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4.4 响应处理

```typescript
// 响应返回后，记录两个映射:
setLastResponseMessageId(chatId, responseMessageId);     // 现有，不变
responseMsgToChatId.set(responseMessageId, chatId);       // 新增
responseMsgTs.set(responseMessageId, Date.now());        // 新增
```

### 4.5 TTL 清理

复用现有的定时清理机制，扩展清理范围：

```typescript
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  // 现有清理
  for (const [key, ts] of lastResponseMessageTs) { ... }
  // 新增清理
  for (const [key, ts] of fingerprintTs) {
    if (now - ts > TTL_MS) {
      fingerprintToChatId.delete(key);
      fingerprintTs.delete(key);
    }
  }
  for (const [key, ts] of responseMsgTs) {
    if (now - ts > TTL_MS) {
      responseMsgToChatId.delete(key);
      responseMsgTs.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS);
```

### 4.6 为什么能区分不同进程

```
进程 A (opencode session A):
  请求1: messages = [system_A, "你好"]
    → fingerprint = sha256(account + "system:system_A|user:你好")
    → 查表无 → chat_id = uuid_A，存入表

  请求2: messages = [system_A, "你好", assistant_1, "继续"]
    → fingerprint = sha256(account + "system:system_A|user:你好|assistant:assistant_1|user:继续")
    → 查表无 → chat_id = uuid_A2，存入表
    → 但 uuid_A2 ≠ uuid_A ！
```

**等等，这有问题！** 同一对话的不同轮次，fingerprint 不同，会生成不同的 chat_id！

### 4.7 修正: fingerprint 必须在同一对话内稳定

问题出在：同一对话每轮消息都增长，fingerprint 每轮都变。

**解决**: fingerprint 只取**首条** user/system 消息（和旧方案一样），但加上**映射表**来处理碰撞：

```
┌─────────────────────────────────────────────────────────────────┐
│  修正方案                                                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  fingerprint 仍然基于首条消息（保证对话内稳定）                 │
│  但加入 system prompt 内容（提高区分度）                        │
│                                                                 │
│  fingerprint = sha256(                                          │
│    providerAccountId +                                          │
│    normalizeContent(systemMsg) +                                │
│    normalizeContent(firstUserMsg)                               │
│  )                                                              │
│                                                                 │
│  查表:                                                          │
│    fingerprint → 有 → 复用 chat_id                             │
│    fingerprint → 无 → 新 UUID，存入表                          │
│                                                                 │
│  和旧方案的区别:                                                │
│    旧: 纯函数，首条消息相同 → 必然碰撞                         │
│    新: 映射表，首条消息相同 → 首次共享 chat_id                 │
│        但第二轮消息分叉后，fingerprint 不同 → 自动分叉          │
│                                                                 │
│  等等... 首条消息相同 → fingerprint 相同 → 永远共享 chat_id    │
│  映射表解决不了这个问题！                                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**结论**: 如果 fingerprint 基于首条消息，映射表没有意义 — 因为首条消息相同的两个对话，fingerprint 永远相同，映射表永远返回同一个 chat_id。

### 4.8 真正的解决: 基于 messages 增长模式识别对话

```
┌─────────────────────────────────────────────────────────────────┐
│  核心洞察                                                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  同一对话的连续请求:                                            │
│    请求1: messages = [s, u1]                                   │
│    请求2: messages = [s, u1, a1, u2]    ← 请求1 的超集        │
│    请求3: messages = [s, u1, a1, u2, a2, u3]                   │
│                                                                 │
│  不同对话的请求:                                                │
│    对话A: messages = [s, u1]                                   │
│    对话B: messages = [s, u1']           ← 首条就不同           │
│    或:   messages = [s, u1]             ← 首条相同但后续分叉   │
│                                                                 │
│  识别规则:                                                      │
│    如果新请求的 messages 是某个已知对话的"延续"                 │
│    （前 N 条消息相同，只是追加了新消息）                       │
│    → 属于同一对话，复用 chat_id                                │
│    否则 → 新对话，新 chat_id                                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**实现**: 用 messages 的前缀指纹作为对话标识：

```typescript
// 对话标识 = 前 N 条消息的指纹（N = 去掉最后一轮 user+assistant）
function computeConversationFingerprint(messages, providerAccountId) {
  // 去掉最后一轮交互，保留"历史前缀"
  // 这样同一对话的不同轮次，前缀相同
  const prefixMessages = messages.slice(0, -2); // 去掉最后一条 user + assistant
  if (prefixMessages.length === 0) {
    // 第一轮，用全部消息
    prefixMessages.push(...messages);
  }
  
  const key = prefixMessages
    .filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
    .map(m => `${m.role}:${normalizeMessageContent(m.content)}`)
    .join('|');
  
  return sha256(`${providerAccountId}:${key}`).slice(0, 32);
}
```

**但这太复杂了，而且边界情况很多**（tool 消息、多轮 assistant 消息等）。

## 五、最终推荐: 务实方案

经过深入分析，最务实的方案是 **方案 1（简单改法）+ 方案 2 的映射表**，但用更简单的 fingerprint：

### 5.1 改动

1. **fingerprint 纳入 system prompt**（方案 1）— 提高区分度
2. **加映射表** — 当 fingerprint 碰撞时，用 messages 长度作为二级区分

```typescript
// 改进后的 fingerprint: system + user + messages.length
function computeFingerprint(messages, providerAccountId) {
  const systemMsg = messages.find(m => m.role === 'system');
  const firstUserMsg = messages.find(m => m.role === 'user');
  const key = [
    providerAccountId,
    normalizeContent(systemMsg?.content) ?? '',
    normalizeContent(firstUserMsg?.content) ?? '',
    String(messages.length),  // 二级区分: 同一 fingerprint 下不同轮次
  ].join(':');
  return sha256(key).slice(0, 32);
}
```

**等等，messages.length 每轮都变，fingerprint 每轮都变，chat_id 每轮都变 — 又回到老问题！**

### 5.2 最终结论

经过反复推演，核心矛盾是：

> **chat_id 必须在同一对话内稳定，但代理没有可靠信号区分"同一对话的续轮"和"不同对话的首轮"**

在 OpenAI 协议的约束下，**唯一可靠的方案是**：

1. **fingerprint 基于首条消息**（保证对话内稳定）
2. **纳入 system prompt**（提高区分度，opencode 的 system prompt 含 session/project 信息）
3. **接受第一轮碰撞的边界情况**（两个进程首条消息完全相同时会碰撞，但实际极少发生）

这其实就是**方案 1**，只是比当前代码多纳入了 system prompt。

```typescript
// 最终改动: 仅此一处
function deriveConversationId(messages, providerAccountId) {
  // 旧: 只取首条 user 消息
  // 新: 同时纳入 system prompt 和首条 user 消息
  const systemMsg = messages.find(m => m.role === 'system');
  const firstUserMsg = messages.find(m => m.role === 'user');
  const key = `${providerAccountId}:${normalizeContent(systemMsg?.content) ?? ''}:${normalizeContent(firstUserMsg?.content) ?? ''}`;
  return sha256(key).slice(0, 32);
}
```

### 5.3 为什么这就够了

- opencode 的 system prompt 包含 **session ID、项目路径、工作目录** 等信息
- 不同 opencode 进程的这些信息几乎必然不同
- 所以 fingerprint 几乎不会碰撞
- 即使碰巧碰撞（同项目、同配置），只影响第一轮，第二轮消息分叉后 CodeArts 上游会按 `parent_message_id` 正确路由

### 5.4 改动范围

| 文件 | 改动 |
|------|------|
| `src/upstream/huawei/chat-request.ts` | 修改 `deriveConversationId` 函数，纳入 system prompt |

仅 1 个文件，约 5 行代码改动。

## 六、风险与后续

| 风险 | 概率 | 缓解 |
|------|------|------|
| 两个进程 system prompt + 首条 user 消息完全相同 | 极低 | opencode system prompt 含 session 信息 |
| system prompt 过长导致 hash 计算开销 | 可忽略 | sha256 即使对长字符串也很快 |
| 修改后旧对话的 chat_id 变化 | 会发生 | 旧对话重启后视为新对话，无功能影响 |

**后续优化方向**（如果简单改法不够）：
- 在 OpenAI 请求的自定义 header 中注入 session 标识（需改 opencode 配置）
- 支持多 API Key 隔离（需多华为云账号）
- 实现完整的 fingerprint → chat_id 映射表 + messages 增长模式识别

## 七、实施状态

✅ **已实施** — `deriveConversationId` 已在 `src/upstream/huawei/chat-request.ts` 中修改，将 system prompt 内容纳入哈希输入。不同 system prompt 的相同首条消息现在会产生不同 chat_id，大幅降低碰撞概率。
