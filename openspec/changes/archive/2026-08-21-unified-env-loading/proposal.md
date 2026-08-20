## Why

`logger.ts` 在模块加载时读取 `LOG_FILE`，而 `.env` 的注入发生在 `config.ts` 中，且 import 顺序上 logger 先于 config 被加载，导致 `.env` 里配置的 `LOG_FILE` 不生效，用户只能在系统环境变量中设置。

## What Changes

- 新增 `src/env.ts`：唯一负责 dotenv 加载的模块，支持 `ENV_FILE` 覆盖 `.env` 路径，幂等且不覆盖已有环境变量
- `index.ts` 首行导入 `env` 模块，确保任何业务模块加载前 `.env` 已注入
- `config.ts` 移除自身 `dotenv.config()` 调用，改从统一 env 模块继承
- `logger.ts` 保持模块级读取 `LOG_FILE`/`LOG_LEVEL`（因 `.env` 已提前注入，行为正确）
- 文档更新：日志配置支持 `.env` 文件说明

## Capabilities

### New Capabilities

- `env-loading`: 统一的环境变量加载（dotenv 注入、`ENV_FILE` 路径覆盖），作为所有模块读取环境变量之前的唯一入口

### Modified Capabilities

- `structured-logging`: `LOG_FILE` 环境变量现在可从 `.env` 文件读取，而不仅限于系统环境变量

## Impact

- 受影响代码：`src/index.ts`、`src/config.ts`、`src/utils/logger.ts`、`src/env.ts`（新增）
- 依赖：`dotenv`（已有依赖，无新增）
- 行为：`LOG_FILE`、`LOG_LEVEL` 从 `.env` 读取有效；dotenv 幂等性保证系统环境变量优先级不变
- 文档：`README` 或环境变量说明补充 `.env` 用法
