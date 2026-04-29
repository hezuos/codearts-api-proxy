## 1. Setup

- [x] 1.1 确认 `openai` 已在 `package.json` 的 `devDependencies` 中（v6.34.0）
- [x] 1.2 创建 `src/types/openai-codearts.ts`，提取 CodeArts 特有类型
- [x] 1.3 补全 `CodeArtsRawToolCall` 的 `index?: number` 字段（`chat-protocol.ts`）

## 2. 类型迁移：重写 openai.ts

- [x] 2.1 用 `import type` 从官方包引入
- [x] 2.2 定义 intersection types
- [x] 2.3 定义 `OpenAIChatMessage` 投影接口
- [x] 2.4 定义 `OpenAIToolCall`, `OpenAITool`, `OpenAIChatRole`
- [x] 2.5 定义 `OpenAIToolCallDelta` 从 `ChatCompletionChunk.Choice.Delta.ToolCall`
- [x] 2.6 定义 `OpenAIModelsResponse`, `OpenAIUsage`, `OpenAIError`
- [x] 2.7 从 `./openai-codearts` 重新导出 CodeArts 类型
- [x] 2.8 删除所有 dead types

## 3. 运行时：透明转发 — chat-translate.ts

- [x] 3.1 重写 `mapToolCallDeltas()` → `cleanToolCallDeltas()`：最小清洗逻辑
- [x] 3.2 重写 `mapToolCalls()` → `cleanToolCalls()`：同上清洗逻辑 + 缺失 id 时生成 UUID
- [x] 3.3 `convertOpenAIToolsToCodeArts()` 已足够简洁，无需改动
- [x] 3.4 删除不再需要的辅助函数（`normalizeToolCallArguments` → `repairSubagentType`，`generateToolCallId` 内联）

## 4. 运行时：透明转发 — chat-stream.ts

- [x] 4.1 合并 role chunk：将 `role` 字段加入首个有内容的 delta chunk
- [x] 4.2 `codearts` 元数据仅首个 chunk 携带：用 `sentMetadata` 标志控制
- [x] 4.3 更新 `mapToolCallDeltas` 调用为 `cleanToolCallDeltas`

## 5. 运行时：透明转发 — chat.ts (非流式)

- [x] 5.1 更新 `mapToolCalls` 调用为 `cleanToolCalls`

## 6. Validation

- [x] 6.1 `pnpm build` 零 TypeScript 错误
- [x] 6.2 验证编译产物无 `openai` 运行时导入（`require("openai")` 不在 dist/ 中）
- [x] 6.3 验证 `openai` 不在 production 依赖中
- [ ] 6.4 用 Zed 客户端测试 tool_call 流式响应：确认 `find_path` → `read_file` 多轮工具调用正常
- [ ] 6.5 用 OpenCode 客户端测试纯文本流式响应：确认正常
