## Why

生产环境缺少 `ENCRYPTION_KEY` 环境变量时，`requireEnv()` 抛出裸的 `Error("Missing required environment variable: ENCRYPTION_KEY")`，进程立即崩溃。错误消息没有说明该变量的用途、如何生成、如何设置，导致 Docker 部署场景下用户无法快速定位和解决问题。

## What Changes

- 改进 `requireEnv()` 函数，支持可选的 `hint` 参数，在变量缺失时输出可操作的指引
- 为 `ENCRYPTION_KEY` 提供详细的错误提示：说明用途（加密 AK/SK 凭证）、生成方法（`crypto.randomBytes`）、设置方式（环境变量或 .env 文件）
- 为其他使用 `requireEnv` 的环境变量也提供相应提示

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `hierarchical-store`: `ENCRYPTION_KEY` 缺失时的错误消息从裸 Error 改为包含可操作指引的详细提示

## Impact

- **src/config.ts** — `requireEnv()` 函数签名变更（添加 hint 参数），`encryptionKey` 配置项的错误消息改进
