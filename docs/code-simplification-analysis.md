# 代码精简优化分析

> 分析日期: 2026-04-24
> 源代码规模: 35 个 TypeScript 文件, 约 5,300 行

## 1. 未使用的依赖（高优先级）

`package.json` 中有多个依赖从未在 `src/` 中被引用：

| 依赖 | 类型 | 状态 |
|------|------|------|
| `uuid` | dependencies | 未使用（代码全部用 `crypto.randomUUID()`） |
| `ws` | dependencies | 未使用（无 WebSocket 功能） |
| `dotenv` | dependencies | 未使用（无 `import dotenv`） |
| `better-sqlite3` | devDependencies | 未使用（用 JSON 文件存储） |
| `openai` | devDependencies | 未使用（手写类型定义） |
| `sql.js` | devDependencies | 未使用 |
| `jest` / `ts-jest` | devDependencies | 未使用（测试用 `ts-node` 直接跑） |
| `@types/uuid` | devDependencies | 随 `uuid` 一起可删 |
| `@types/ws` | devDependencies | 随 `ws` 一起可删 |

**建议**: 从 `package.json` 中移除上述依赖，执行 `pnpm install` 清理 lockfile。

---

## 2. 未使用的类型定义（高优先级）

`src/types/openai.ts` 中有大量从未被任何其他文件导入的类型：

```
OpenAIResponse, OpenAIModelPermission, OpenAIFunctionCall,
OpenAIFunctionDefinition, OpenAILogProbs, OpenAILogProbsContent,
OpenAITopLogProb, OpenAIEmbeddingRequest, OpenAIEmbedding,
OpenAIEmbeddingsResponse, ModelMapping, ProxyConfig, AuthConfig,
OpenAIToCodeArtsConverter, CodeArtsToOpenAIConverter,
CodeArtsChatRequest, CodeArtsChatResponse,
EventType, StreamEvent, StreamCallback
```

这些类型约占该文件 **60%** 的行数（约 240 行），可以安全删除。

**建议**: 删除上述未使用的类型定义，保留文件中实际被引用的类型。

---

## 3. 未使用的导出函数（中优先级）

| 文件 | 函数 | 说明 |
|------|------|------|
| `src/translation/openai-mock.ts` | `buildCompletionResponse`, `buildStreamingChunks`, `getPromptText` | 仅 `buildModelsResponse` 被导入，其余两个 mock 函数从未使用 |
| `src/auth/huawei/session-store.ts` | `deleteSession` | 空操作 no-op，仅"保持 API 兼容"但无调用者 |
| `src/auth/huawei/refresh-task.ts` | `setMasterNode` | 导出但从未被调用 |
| `src/auth/admin.ts` | `getAdminSource` | 导出但从未被调用 |
| `src/auth/store.ts` | `_removeApiKeyFromValueIndex` | 导入但从未使用 |
| `src/store/hierarchical-store.ts` | `removeApiKeyFromValueIndex` | 仅被上面的未使用导入引用 |

**建议**: 删除上述未使用的函数和导入。

---

## 4. 重复代码（高优先级）

### 4a. `getCredentials()` 函数重复

`chat.ts:379` 和 `models.ts:55` 有完全相同的实现：

```typescript
function getCredentials(session: StoredHuaweiSession): SigningCredentials {
  if (!session.accessKey || !session.secretKeyCiphertext) {
    throw new Error("Session missing AK/SK credentials");
  }
  return {
    accessKey: session.accessKey,
    secretKey: decryptString(session.secretKeyCiphertext),
    securityToken: session.securityToken,
  };
}
```

**建议**: 提取到 `src/auth/huawei/credentials.ts` 共享模块。

### 4b. `maskValue()` 函数重复

`huawei-auth.ts:58` 和 `ticket.ts:26` 有完全相同的实现。

**建议**: 提取到 `src/utils/mask.ts`。

### 4c. `isProduction` 重复计算

`huawei-auth.ts` 中 4 处、`web-ui.ts` 中 1 处、`authenticate-admin.ts` 中 1 处，共 6 处重复 `process.env.NODE_ENV === "production"`。

**建议**: 在 `config.ts` 中添加 `export const isProduction = config.nodeEnv === "production"`。

### 4d. `chat.ts` 中流式/非流式函数大量重复

`streamHuaweiChatToResponse` 和 `sendHuaweiChatRequest` 共享以下重复逻辑（约 200 行）：

- 请求日志输出（621-646 vs 905-924）
- 连续性信息日志（649-664 vs 927-941）
- HTTP 错误处理（693-704 vs 947-958）
- SSE meta 事件处理（728-739 vs 972-982）
- `lastResponseMessageId` 更新逻辑（840-862 vs 1014-1032）
- 完成日志（865-879 vs 1033-1046）

**建议**: 提取共享逻辑为内部辅助函数，两个主函数只保留各自独有的流式/非流式处理逻辑。

---

## 5. `chat.ts` 过大（1070 行）（高优先级）

这是最大的文件，职责混杂：

```
┌──────────────────────────────────────────────────────┐
│                    chat.ts (1070行)                   │
├──────────────────────────────────────────────────────┤
│  模型映射 (87-107)                    ~20行          │
│  会话ID推导 (120-145)                 ~25行          │
│  请求体构造 (151-373)                 ~220行         │
│  HTTP/SSE传输 (379-525)               ~145行         │
│  Tool调用转换 (530-604)               ~75行          │
│  流式响应主函数 (610-893)             ~280行         │
│  非流式响应主函数 (895-1070)          ~175行         │
└──────────────────────────────────────────────────────┘
```

**建议拆分方案**:

| 新文件 | 职责 | 预计行数 |
|--------|------|---------|
| `chat-request.ts` | 请求体构造 + 模型映射 + 会话ID推导 | ~265 |
| `chat-stream.ts` | 流式响应 | ~280 |
| `chat-non-stream.ts` | 非流式响应 | ~175 |
| `chat-transport.ts` | HTTP/SSE 传输层 | ~145 |
| `chat.ts` | 公共 API + re-export + tool 转换 | ~95 |

---

## 6. 冗余的 `tools.ts` 定义（中优先级）

`SUB_AGENT_TOOLS`（191行）和 `SUB_AGENT_TOOL_NAMES`（197行）存在冗余——工具名列表重复定义了两次。

**当前**:
```typescript
export const SUB_AGENT_TOOLS = DEFAULT_TOOLS.filter(t =>
  ["Bash", "Glob", "Grep", "Read", "openBrowserInIDE"].includes(t.function.name)
);
const SUB_AGENT_TOOL_NAMES = new Set(["Bash", "Glob", "Grep", "Read", "openBrowserInIDE"]);
```

**建议**:
```typescript
const SUB_AGENT_TOOL_NAMES = new Set(["Bash", "Glob", "Grep", "Read", "openBrowserInIDE"]);
export const SUB_AGENT_TOOLS = DEFAULT_TOOLS.filter(t => SUB_AGENT_TOOL_NAMES.has(t.function.name));
```

---

## 7. 过度冗长的日志代码（中优先级）

`chat.ts` 中日志代码占比极高。流式和非流式函数中，日志行数约占总行数的 **40%**。例如 `streamHuaweiChatToResponse` 中 621-686 行全是日志（65 行），865-879 行又是日志（15 行）。

**建议**:
- 将请求/响应日志提取为 `logOutgoingRequest()` / `logStreamComplete()` 辅助函数
- 这同时解决了 4d 中流式/非流式的日志重复问题

---

## 8. `admin.ts` 中重复的账户查找模式（低优先级）

`getAccountDetails`、`forceRefreshAccount`、`deleteAccount` 三个函数都包含相同的"遍历所有用户查找账户"模式：

```typescript
const users = listAllUsers();
for (const user of users) {
  const accounts = listProviderAccounts(user.id);
  const account = accounts.find((a) => a.id === accountId);
  if (account) { ... break; }
}
```

**建议**: 提取为 `findAccountOwner(accountId): { user, account } | null`。

---

## 9. `admin.ts` 中重复的 API Key 详情映射（低优先级）

`getAllAccounts` 和 `getAccountDetails` 有相同的 key→session 映射逻辑。

**建议**: 提取为 `mapApiKeyDetails(apiKey, session)` 辅助函数。

---

## 10. `Reflect.set` / `Reflect.get` 用于请求上下文（低优先级）

`authenticate-api-key.ts` 和 `request-context.ts` 使用 `Reflect.set(req, ...)` / `Reflect.get(req, ...)` 来附加自定义属性。这是非标准做法。

**建议**: 用 `declare global` 扩展 Express Request 类型（如 `authenticate-ui.ts` 已经做的那样），或使用 `Symbol` 键 + `WeakMap`。

---

## 优化优先级矩阵

| # | 优化项 | 预计减少行数 | 影响范围 | 风险 |
|---|--------|-------------|---------|------|
| 1 | 删除未使用依赖 | ~0 (package.json) | 低 | 无 |
| 2 | 删除未使用类型 | ~240行 | types/openai.ts | 无 |
| 3 | 删除未使用导出 | ~50行 | 多文件 | 无 |
| 4a | 提取 getCredentials | ~10行 | chat.ts, models.ts | 低 |
| 4b | 提取 maskValue | ~10行 | huawei-auth.ts, ticket.ts | 低 |
| 4c | 提取 isProduction | ~5行 | 多文件 | 低 |
| 4d | 消除 chat.ts 流式/非流式重复 | ~150行 | chat.ts | 中 |
| 5 | 拆分 chat.ts | 0 (重组) | chat.ts | 中 |
| 6 | 消除 tools.ts 冗余 | ~3行 | tools.ts | 无 |
| 7 | 提取日志辅助函数 | ~80行 | chat.ts | 低 |
| 8 | 提取账户查找辅助 | ~30行 | admin.ts | 低 |
| 9 | 提取 key 详情映射 | ~20行 | admin.ts | 低 |
| 10 | 替换 Reflect 为类型扩展 | ~0 (风格) | middleware/ | 低 |

**总计可精简约 590 行代码**（从 ~5,300 行降至 ~4,710 行，减少约 11%）。
