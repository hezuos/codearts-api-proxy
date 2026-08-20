## 1. 统一 env 模块

- [x] 1.1 新建 `src/env.ts`：模块级执行 `dotenv.config()`，保留 `ENV_FILE` 覆盖逻辑，头部注释说明"副作用模块，仅 import 不引用"及模块级读 env 约定
- [x] 1.2 `src/config.ts` 删除 dotenv import 与调用，改为 `import "./env"`
- [x] 1.3 `src/utils/logger.ts` 顶部加 `import "./env"`（实际路径为 `"../env"`）
- [x] 1.4 `src/index.ts` 首行加 `import "./env"`

## 2. 验证

- [x] 2.1 运行 `pnpm run lint` 与 `pnpm run build` 通过
- [x] 2.2 在 `.env` 写入 `LOG_FILE` 后启动，确认日志落盘且终端仍输出
- [x] 2.3 验证系统环境变量优先：预设 `LOG_FILE` 后再启动，日志写入预设路径而非 `.env` 值
