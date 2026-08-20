/**
 * 统一环境变量加载模块（副作用模块，仅 import 不引用）。
 *
 * 必须在任何"模块加载时读取环境变量"的模块之前被加载，否则 .env 中的
 * 变量（如 LOG_FILE、LOG_LEVEL）在模块求值时尚未注入。
 *
 * 约定：所有在模块顶层读取 process.env 的文件都应显式 import "./env"，
 * 以保证无论从哪个入口（index.ts / 测试 / scripts）启动都先注入 .env。
 *
 * dotenv 默认不覆盖已存在的进程环境变量，因此系统环境变量优先于 .env。
 */

import dotenv from "dotenv";

// 默认路径为 process.cwd()/.env，可通过 ENV_FILE 环境变量覆盖；quiet 关闭 dotenv 的注入日志
const envFilePath = process.env.ENV_FILE;
dotenv.config(envFilePath ? { path: envFilePath, quiet: true } : { quiet: true });

/**
 * 环境注入完成标记（仅用于满足副作用 import 的类型解析，无业务含义）。
 * 不要引用此值，本模块只应被 import，不提供 API。
 */
export const envInjected = true;
