## Why

当前代理在构造上游 CodeArts 请求时，混入了来自代理自身运行环境的默认值（如 `process.cwd()`、`process.platform`），以及对调用方未提供字段的过度推断。代理的职责是授权/鉴权/会话保持/协议适配，不应替调用方"脑补上下文"，也不应将代理自身的运行环境混入上游请求。

## What Changes

- **去掉 `process.cwd()` 作为 `currentWorkingDirectory` 的兜底**：缺失时用空字符串，调用方必须显式提供
- **去掉 `process.platform` 作为 `osVersion` 的兜底**：缺失时使用抓包对齐的固定值 `"win32"`
- **明确区分"协议必须适配的字段"与"可透传的上下文字段"**：前者只做最小适配，后者优先取自调用方
- **补全调用方可传入的上下文字段**：扩展 `codearts` 扩展字段，让调用方可以显式提供工作目录、OS 版本、语言偏好等
- **确认并收敛 `task_parameters` 中所有有默认值的字段**：对照抓包，非调用方提供的字段只用抓包确认的固定值，不自发明

## Capabilities

### New Capabilities

- `proxy-context-passthrough`: 定义哪些上下文字段可由调用方显式传入、哪些由代理按最小默认值填充、哪些是协议适配必须转换的字段；建立"proxy 原则"的字段级规则

### Modified Capabilities

（无——本次变更是实现层收敛，不引入新的对外行为规范，但对 `proxy-context-passthrough` 是首次建立规范）

## Impact

- `src/upstream/huawei/chat.ts`：`getCurrentWorkingDirectory`、`getOsVersion`、`buildTaskParameters`
- `src/types/openai.ts`：`codearts` 扩展字段（确认调用方可传字段的完整性）
- `docs/request-and-api.md`：补充 proxy 原则说明和字段来源说明
