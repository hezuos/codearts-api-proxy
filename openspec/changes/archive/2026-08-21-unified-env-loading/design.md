## Context

- 当前 `dotenv.config()` 只存在于 `src/config.ts`（L1-6），且 `logger.ts` 在模块加载时读取 `LOG_FILE`/`LOG_LEVEL`。
- Node.js CommonJS 按 import 顺序深度优先加载：`index.ts` → `auth/huawei/refresh-task` 链先加载 `logger`（模块级读 `LOG_FILE`），`config` 后加载才执行 dotenv，导致 `.env` 中的 `LOG_FILE` 读不到。
- 除 `index.ts` 外，测试文件与 `scripts/` 也以 ts-node 直接入口运行，不能只依赖 `index.ts` 一处注入。

## Goals / Non-Goals

**Goals:**
- 让 `.env` 中的 `LOG_FILE`、`LOG_LEVEL` 生效。
- 建立唯一、确定性的 env 注入点，根治"模块级读 env 早于 dotenv"一类问题。
- 保持现有行为：系统环境变量优先于 `.env`（dotenv 默认不覆盖），`ENV_FILE` 支持保留。

**Non-Goals:**
- 不改变 `logger.ts` 的读取方式（仍模块级读取，但此时 env 已注入）。
- 不引入新的环境变量或配置项。
- 不改动任何既有环境变量的语义。

## Decisions

### D1: 新建 `src/env.ts` 作为唯一 dotenv 加载点

```ts
import dotenv from "dotenv";

const envFilePath = process.env.ENV_FILE;
dotenv.config(envFilePath ? { path: envFilePath, quiet: true } : { quiet: true });
```

- 模块级执行（无导出亦可），Node 模块缓存保证全局只执行一次。
- 替代 `config.ts` 中现有的 dotenv 调用，逻辑原样搬移，保证 `ENV_FILE` 覆盖语义不变。

### D2: 所有"模块级读 env"的模块显式依赖 env 模块

- `src/config.ts`：删除 `dotenv` import 与调用，改为 `import "./env"`。
- `src/utils/logger.ts`：顶部加 `import "./env"`，保证任何入口（index/测试/scripts）只要加载 logger 就已注入 `.env`。
- `src/index.ts`：首行 `import "./env"`，作为主入口的显式保障（加载顺序不依赖模块图推断）。

由于模块缓存，多入口 import 无副作用，dotenv 只执行一次。

**备选方案对比：**
| 方案 | 结论 |
|------|------|
| 仅改 `index.ts` 首行 import | 测试/scripts 入口不经过 index.ts，不彻底 → 否决 |
| logger 惰性读取 `LOG_FILE`（首次写文件时再求值） | 可解决但改变 logger 内部结构，且仅覆盖 logger；env 注入点仍分散 → 否决 |
| 新建 `env.ts` + 依赖方显式 import（D1+D2） | ✅ 单一入口 + 所有入口安全，改动最小且彻底 |

### D3: 保持 dotenv 默认不覆盖语义

dotenv 默认 `override: false`，已存在的进程环境变量（如系统 `setx` 设置）优先于 `.env`，与现状一致，无需额外代码。

## Risks / Trade-offs

- [`env.ts` 被多个模块 import，若有人误以为每次 import 都重载] → 模块缓存保证只执行一次；`env.ts` 不导出任何 API，注释明确"副作用模块，仅 import 不引用"。
- [其他模块（非 logger/config）在模块级读 env 变量] → 当前代码库模块级读 env 的只有 logger 与 config，均已覆盖；后续新增此类模块需 import `./env`，在 `env.ts` 头部注释中写明约定。
- [`process.cwd()` 变化导致 `.env` 路径漂移] → 与现状一致（dotenv 默认按 cwd），非本 change 引入。

## Migration Plan

1. 新增 `src/env.ts`。
2. 修改 `config.ts`、`logger.ts`、`index.ts` 三处 import。
3. 用 `LOG_FILE=D:\x.log` 写入 `.env` 后启动验证日志落盘；并验证系统环境变量仍可覆盖 `.env`。
4. 回滚：删除 `env.ts`，还原 `config.ts` 的 dotenv 调用，还原 `logger.ts`/`index.ts` 的 import 即可。
