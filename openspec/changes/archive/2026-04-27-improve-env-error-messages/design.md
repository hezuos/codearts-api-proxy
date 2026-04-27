## Context

当前 `src/config.ts` 中的 `requireEnv()` 函数在环境变量缺失时只抛出 `Error("Missing required environment variable: ${name}")`，没有任何上下文信息。生产环境部署（尤其是 Docker 容器）中，用户看到这个错误后不知道该变量做什么、怎么生成、怎么设置。

## Goals / Non-Goals

**Goals:**
- `requireEnv()` 支持可选的 `hint` 参数，在变量缺失时输出可操作的指引
- `ENCRYPTION_KEY` 缺失时提供详细提示：用途、生成方法、设置方式

**Non-Goals:**
- 不改变生产环境必须设置 `ENCRYPTION_KEY` 的行为（仍然抛错退出）
- 不为所有环境变量添加 hint（只为关键变量添加）
- 不改变开发环境的 fallback 行为

## Decisions

### D1: requireEnv 签名扩展 — 添加可选 hint 参数

**选择**: `requireEnv(name: string, fallback?: string, hint?: string): string`，当变量缺失且无 fallback 时，如果提供了 hint，将其附加到错误消息中。

**替代方案**: 为每个环境变量单独写错误处理逻辑 — 重复代码，不易维护。

**理由**: `requireEnv` 是通用的环境变量读取函数，hint 参数让它可以为任何变量提供上下文，同时保持调用点简洁。

### D2: ENCRYPTION_KEY 的 hint 内容

**选择**: 包含三部分信息：
1. 用途说明：该密钥用于加密存储在 `data/` 目录中的 AK/SK 凭证
2. 生成方法：`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
3. 设置方式：通过环境变量或 .env 文件

**理由**: 这三部分信息覆盖了用户从"不知道这个变量做什么"到"设置好并重启"的完整路径。

## Risks / Trade-offs

- **[hint 文本维护]** 如果加密机制变化，hint 中的用途说明可能过时 → hint 保持简短，只描述当前用途
