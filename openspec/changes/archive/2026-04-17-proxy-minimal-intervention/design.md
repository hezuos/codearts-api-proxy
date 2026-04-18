## Context

代理当前在 `src/upstream/huawei/chat.ts` 的 `buildTaskParameters` 函数中，对调用方未显式提供的字段做了过度的默认推断：

- `getCurrentWorkingDirectory`：优先级链末尾回退到 `process.cwd()`，将代理自身运行目录混入上游请求
- `getOsVersion`：回退到 `process.platform`，将代理运行平台混入上游请求
- 其余字段（`codebase_search`、`enable_code_interpreter`、`projectLevelPrompt`、`preferred_language`）的默认值经抓包验证与真实宿主一致，属于合理的协议固定值

`src/types/openai.ts` 中的 `OpenAICodeArtsRequestOptions` 已包含调用方可传入的主要字段，整体结构完整。

## Goals / Non-Goals

**Goals:**

- 明确代理在字段填充上的三类行为：透传、协议转换、最小默认值
- 去掉所有将代理运行环境混入上游请求的回退逻辑
- 建立字段来源规则，使每个 `task_parameters` 字段的填充依据清晰可查

**Non-Goals:**

- 不改变代理的对外 API 形状（`OpenAICodeArtsRequestOptions` 字段保持兼容）
- 不修改工具 schema（`tools.ts`）的内容，该部分有独立的对齐工作
- 不改变会话链路（`conversation-store`）的行为

## Decisions

### D1：`currentWorkingDirectory` 缺失时用空字符串，不用 `process.cwd()`

**选择**：缺失时返回 `""`

**理由**：`process.cwd()` 是代理进程的工作目录，与用户项目无关。CodeArts 上游收到空字符串时的行为（忽略或使用服务端默认）优于收到错误目录。

**备选**：抛错要求调用方必填 — 过于严格，现有客户端可能不传此字段

### D2：`osVersion` 缺失时用 `"win32"`，不用 `process.platform`

**选择**：缺失时返回 `"win32"`

**理由**：抓包中真实宿主（Windows 上的 CodeArts IDE 插件）发送的值就是 `"win32"`。代理自身可能运行在任意平台（Linux 容器等），`process.platform` 会产生错误值。`"win32"` 是当前 CodeArts 插件唯一已知的合法值。

**备选**：用空字符串 — 风险是上游不接受空值

### D3：`codebase_search`、`enable_code_interpreter`、`projectLevelPrompt`、`preferred_language` 保持当前默认值

**选择**：维持现状（`false`/`false`/`""`/`"zh-cn"`）

**理由**：抓包中真实宿主发送的就是这些值。这不是"代理脑补"，而是与上游协议对齐的固定默认值，调用方可通过 `codearts` 扩展字段覆盖。

### D4：字段来源的三类规则（文档化）

为每个 `task_parameters` 字段标注来源类型，便于后续维护：

- **PASSTHROUGH**：优先来自调用方，缺失时不填或用空值
- **PROTOCOL**：协议转换必须填，固定值来自抓包，不受调用方控制
- **CALLER_OR_DEFAULT**：优先来自调用方，缺失时用抓包对齐的固定默认值

## Risks / Trade-offs

- `currentWorkingDirectory` 改为空字符串后，如果上游对空值处理有问题，会导致功能异常。但这优于混入错误路径，且调用方可以显式传入该字段。
- `"win32"` 的 `osVersion` 默认值是当前唯一已知值，若 CodeArts 未来支持其他平台可能需要更新。

## Migration Plan

已完成：

1. `getCurrentWorkingDirectory` 去掉 `process.cwd()` 回退 ✓
2. `getOsVersion` 去掉 `process.platform` 回退 ✓

待完成（tasks 中跟踪）：3. 在代码注释中为每个字段标注来源类型（PASSTHROUGH / PROTOCOL / CALLER_OR_DEFAULT）4. 更新 `docs/request-and-api.md` 说明字段来源规则
