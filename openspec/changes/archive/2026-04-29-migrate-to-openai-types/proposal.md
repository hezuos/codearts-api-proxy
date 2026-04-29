## Why

两个问题需要同时解决：

1. **类型定义漂移**：手写的 `src/types/openai.ts`（191 行）与 OpenAI API 规范持续脱节，缺少新字段，包含 dead types。官方 `openai` npm 包 (v6.34.0) 提供了与 API 同步的 TypeScript 类型，通过 `import type`（零运行时开销）引入可消除漂移问题。

2. **翻译层过度翻译**：当前 `mapToolCallDeltas()` 将 CodeArts SSE delta 拆散、重构、再组装为 OpenAI chunk delta，但两者格式几乎完全相同——唯一差异是 CodeArts 用 `null` 表示"字段不存在"，OpenAI 直接省略。过度翻译已导致多个 bug：
   - `name:"unknown"` 在后续 chunk 中覆盖正确的 tool name
   - `finish_reason:"stop"` 导致客户端不执行 tool（已修复为 `"tool_calls"`）
   - 每个 chunk 重复携带 `codearts` 元数据
   - role 单独发一个 chunk 而非合并到首个 delta

## What Changes

### 编译时：类型迁移
- 添加 `openai` 为 `devDependencies`（仅类型，无运行时使用）
- 重构 `src/types/openai.ts`：手写类型 → `import type` 官方包 + intersection types 注入 CodeArts 扩展
- 提取 CodeArts 特有类型到 `src/types/openai-codearts.ts`
- 删除 dead types
- 补全 `CodeArtsRawToolCall` 的 `index` 字段（CodeArts 实际已发送，类型定义遗漏）

### 运行时：透明转发
- `mapToolCallDeltas()` → `cleanToolCallDeltas()`：最小清洗（删 null、删冗余顶层字段），不再重构对象
- `mapToolCalls()`（非流式）→ 同理简化
- role chunk 合并到首个 delta chunk，不再单独发送
- `codearts` 元数据仅首个 chunk 携带
- `convertOpenAIToolsToCodeArts()` 简化为类型断言 + 填默认值（格式几乎相同）

## Capabilities

### New Capabilities
- `openai-type-integration`: Type definitions derived from the official `openai` npm package with CodeArts extensions via intersection types
- `transparent-streaming`: CodeArts SSE delta → OpenAI chunk delta 最小清洗透传，消除过度翻译

### Modified Capabilities

## Impact

- `src/types/openai.ts` — major rewrite（191 → ~80 行）
- `src/types/openai-codearts.ts` — new file（CodeArts-specific types extracted）
- `src/upstream/huawei/chat-protocol.ts` — 补全 `CodeArtsRawToolCall.index` 字段
- `src/upstream/huawei/chat-translate.ts` — `mapToolCallDeltas` / `mapToolCalls` 重写为最小清洗；`convertOpenAIToolsToCodeArts` 简化
- `src/upstream/huawei/chat-stream.ts` — role chunk 合并；codearts 元数据仅首个 chunk
- `package.json` — add `openai` to `devDependencies`
- `src/upstream/huawei/chat.ts` — `mapToolCalls` 调用适配
- `src/upstream/huawei/tools.ts` — `convertOpenAIToolsToCodeArts` 简化
- Docker image — no impact（`openai` is devDependency, excluded from prod）
