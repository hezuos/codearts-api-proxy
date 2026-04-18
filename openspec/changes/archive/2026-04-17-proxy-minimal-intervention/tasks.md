## 1. 代码修复（已完成）

- [x] 1.1 `getCurrentWorkingDirectory`：去掉 `process.cwd()` 和 `request.user` 回退，缺失时返回 `""`
- [x] 1.2 `getOsVersion`：去掉 `process.platform` 回退，缺失时返回 `"win32"`

## 2. 代码注释标注

- [x] 2.1 在 `buildTaskParameters` 中为每个字段添加注释，标注其来源类型（PASSTHROUGH / PROTOCOL / CALLER_OR_DEFAULT）

## 3. 文档更新

- [x] 3.1 在 `docs/request-and-api.md` 中补充"字段来源规则"章节，说明三类填充规则及各字段归属

## 4. 验证

- [x] 4.1 确认调用方不传 `codearts.current_working_directory` 时，上游请求中 `currentWorkingDirectory` 为空字符串而非代理进程目录
- [x] 4.2 确认调用方不传 `codearts.os_version` 时，上游请求中 `osVersion` 为 `"win32"` 而非 `process.platform`
