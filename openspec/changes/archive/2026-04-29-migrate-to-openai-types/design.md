## Context

两个问题需要同时解决：

**类型漂移**：手写的 `src/types/openai.ts`（191 行）与 OpenAI API 规范持续脱节。官方 `openai` npm 包 (v6.34.0) 提供了与 API 同步的 TypeScript 类型。

**过度翻译**：CodeArts SSE delta 格式与 OpenAI chunk delta 格式几乎完全相同：

```
CodeArts SSE delta                    OpenAI chunk delta
──────────────────                    ──────────────────
role: "assistant"                     role: "assistant"           ← 相同
content: "text"                       content: "text"            ← 相同
reasoning_content: "..."             reasoning_content: "..."   ← 相同(非标准)
tool_calls: [{                        tool_calls: [{
  id: "call_xxx" / null,               index: number,            ← CodeArts已有
  type: "function" / null,             id?: string,              ← null→省略
  index: 0,                            type?: "function",        ← null→省略
  function: {                          function?: {
    name: "tool" / null,                 name?: string,           ← null→省略
    arguments: "..."                     arguments?: string
  }                                    }
}]                                    }]
```

唯一差异：CodeArts 用 `null` 表示"字段不存在"，OpenAI 直接省略。当前 `mapToolCallDeltas()` 做了大量重构（提取 name、构造新 func 对象、硬编码 type），已导致 `name:"unknown"` 和 `finish_reason:"stop"` 等 bug。

## Goals / Non-Goals

**Goals:**
- 替换手写 OpenAI 类型为官方包 `import type`
- 删除 dead types
- 提取 CodeArts 特有类型到独立文件
- 通过 intersection types 注入 CodeArts 扩展
- 保持向后兼容的类型别名
- **将 `mapToolCallDeltas()` / `mapToolCalls()` 重写为最小清洗函数**
- **role chunk 合并到首个 delta**
- **`codearts` 元数据仅首个 chunk**
- **补全 `CodeArtsRawToolCall.index` 字段**
- **简化 `convertOpenAIToolsToCodeArts()`**

**Non-Goals:**
- 运行时使用 `openai` SDK — 仅类型
- 改变代理的 API 接口或行为（输出格式不变，只是实现更简单）
- 支持官方包定义的所有字段 — 只支持代理用到的
- Declaration merging — 太脆弱
- 改变 `extractUserMessage()` / `extractToolResults()` / `buildRequestBody()` — 这些翻译是必要的

## Decisions

### 1. Intersection types over declaration merging

**Decision:** 使用 `type X = OfficialType & { codearts?: ... }`。

**Rationale:** Declaration merging 需要内部模块路径，且无法增强嵌套 namespace 类型。

### 2. Projection interface for OpenAIChatMessage

**Decision:** 自定义 `OpenAIChatMessage` 投影接口，包含代理实际访问的属性。

**Rationale:** 官方 `ChatCompletionMessageParam` 是 5 种变体的 discriminated union，代理遍历消息数组时需要 narrowing。

### 3. CodeArts types in separate file

**Decision:** 提取到 `src/types/openai-codearts.ts`。

**Rationale:** CodeArts 类型是领域逻辑，不是 OpenAI 类型扩展。分离使依赖方向清晰。

### 4. openai as devDependency only

**Decision:** `openai` 仅作为 `devDependencies`，运行时永不导入。

**Rationale:** `import type` 编译后完全擦除。

### 5. Type alias naming strategy

**Decision:** 保持 `OpenAI*` 命名约定。

**Rationale:** 所有消费代码使用 `OpenAI*` 名称，重命名无功能收益。

### 6. Minimal cleaning over full reconstruction (NEW)

**Decision:** `mapToolCallDeltas()` 重写为 `cleanToolCallDeltas()`，只做 null 值清洗和冗余字段删除，不重构对象。

**Rationale:** CodeArts 的 tool_call delta 和 OpenAI 的 `Delta.ToolCall` 结构几乎完全相同。当前的重构逻辑（提取 name、构造新 func 对象、硬编码 type）是过度翻译，已导致 `name:"unknown"` bug。清洗函数更简单、更不容易出 bug。

**Alternatives considered:**
- 保持当前重构逻辑：已证明容易出 bug
- 完全透传（连 null 都不删）：OpenAI 客户端可能将 `id: null` 解析为字符串 "null"

### 7. Role chunk merged into first delta (NEW)

**Decision:** 不单独发送 `{ role: "assistant" }` chunk，将 role 合并到首个有内容的 delta chunk。

**Rationale:** OpenAI 官方行为是 role 和首个 content/tool_calls 在同一 chunk。单独发 role chunk 增加一次网络往返，且某些客户端可能对只有 role 的 chunk 处理有差异。

**Alternatives considered:**
- 保持单独 role chunk：更保守，但多一次网络往返

### 8. codearts metadata only in first chunk (NEW)

**Decision:** `codearts` 扩展字段仅在首个 chunk 携带，后续 chunk 不包含。

**Rationale:** `codearts` 是非标准扩展字段，客户端不应依赖每个 chunk 都有。减少冗余数据传输。

### 9. CodeArtsRawToolCall index field (NEW)

**Decision:** 在 `CodeArtsRawToolCall` 接口中补全 `index?: number` 字段。

**Rationale:** CodeArts SSE 实际数据已包含 `index` 字段（从日志验证），但类型定义遗漏。当前 `mapToolCallDeltas` 用数组位置 `i` 作为 index，应优先使用 CodeArts 提供的 `index`。

## Risks / Trade-offs

- **[Official package type paths are internal]** → Mitigation: 只从文档化的顶层路径导入。类型别名将修复范围限制在一个文件。

- **[ChatCompletionMessageParam may not assign to OpenAIChatMessage]** → Mitigation: 投影接口结构兼容，TypeScript 结构化类型应允许赋值。编译验证。

- **[Intersection with satisfies operator]** → Mitigation: TypeScript 4.9+ 支持。项目使用 5.9。

- **[Role chunk 合并可能影响客户端]** → Mitigation: OpenAI 官方行为就是合并的。Zed 和 OpenCode 都应兼容。如有问题可回退。

- **[codearts 仅首个 chunk 可能影响依赖它的客户端]** → Mitigation: 非标准扩展，客户端不应依赖。如有问题可改为仅首个和最后一个 chunk 携带。

- **[CodeArts 某些事件可能缺少 index]** → Mitigation: 清洗函数有 fallback（用数组位置）。类型为 `index?: number`（可选）。
