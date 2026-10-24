// 统一 env 加载入口（副作用模块）：在读取任何环境变量之前注入 .env，详见 src/env.ts
import "./env";

export interface AppConfig {
  port: number;
  callbackPort: number;
  nodeEnv: string;
  requestBodyLimit: string;
  dataDir: string;
  encryptionKey: string;
  defaultApiKey: string;
  huaweiApiHost: string;
  huaweiChatHost: string;
  /**
   * Upstream chat endpoint path (OpenAI-compatible v2 channel).
   * Default: /api/v2/chat/completions — the only channel that supports glm-5.3.
   */
  huaweiV2ChatPath: string;
  huaweiIamHost: string;
  huaweiRedirectHost: string;
  enableRefreshTask: boolean;
  /** IDE product version — must match server requirements */
  ideVersion: string;
  /** Extension (plugin) version — must match server requirements */
  pluginVersion: string;
  /** GPTs (agent-center) URL override. If not set, derived from huaweiChatHost + isInnerVersion */
  huaweiGptsUrl: string;
  /** Agent ID to query for model list. If not set, derived from isInnerVersion:
   *  - Internal: "CodeMate" (brandName)
   *  - External: "Pangu_Doer_in_CodeArts" */
  huaweiAgentId: string;
  /** Whether the upstream is the internal version (affects URL path and response parsing) */
  isInnerVersion: boolean;
  /** Model list cache TTL in seconds (default: 300 = 5 minutes) */
  modelCacheTtl: number;
  /**
   * Upstream CodeArts hard limit on cumulative prompt length in tokens (default: 196608).
   * Requests exceeding this trigger ChatAgent.00001216. Used for logging/docs only.
   */
  upstreamPromptTokenLimit: number;
  /**
   * Maximum concurrent upstream chat requests per provider account (default: 3).
   * CodeArts rejects the 4th in-flight request for one account with HTTP 400 /
   * TM.00001041 ("并发会话数已达上限(3个)"). 0 disables the local gate.
   */
  upstreamMaxConcurrency: number;
  /**
   * Maximum time a request may wait for an upstream slot (default: 120000ms).
   * 0 waits forever (until the client aborts).
   */
  upstreamQueueWaitTimeoutMs: number;
  /** Retries when upstream reports the concurrent-session limit (default: 2). */
  upstreamConcurrencyRetryMax: number;
  /** Base backoff for concurrent-session retries in milliseconds (default: 1500). */
  upstreamConcurrencyRetryDelayMs: number;
  /**
   * Lower bound for the adaptive per-account concurrency limit (default: 1).
   * 撞限后有效上限逐级下调，最低降到该值。
   */
  upstreamMinConcurrency: number;
  /**
   * 连续无撞限多久后逐级恢复有效上限（默认 60000ms）。
   * 槽位是账号级共享的（官方 IDE / 其他客户端也会占用），无法预先感知。
   */
  upstreamConcurrencyRecoverMs: number;
}

function requireEnv(name: string, fallback?: string, hint?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    const message = hint
      ? `Missing required environment variable: ${name}\n\n${hint}`
      : `Missing required environment variable: ${name}`;
    throw new Error(message);
  }
  return value;
}

export const config: AppConfig = {
  port: Number(process.env.PORT ?? 1455),
  callbackPort: Number(process.env.CALLBACK_PORT ?? process.env.PORT ?? 1455),
  nodeEnv: process.env.NODE_ENV ?? "development",
  requestBodyLimit: process.env.REQUEST_BODY_LIMIT ?? "10mb",
  dataDir: process.env.DATA_DIR ?? "data",
  encryptionKey: requireEnv(
    "ENCRYPTION_KEY",
    (process.env.NODE_ENV ?? "development") === "production"
      ? undefined // Production MUST set ENCRYPTION_KEY — no insecure fallback
      : "dev-only-32-byte-encryption-key!",
    "ENCRYPTION_KEY encrypts AK/SK credentials stored in the data/ directory.\n" +
      "Generate a key: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"\n" +
      "Set via: ENCRYPTION_KEY=<key> in environment or .env file",
  ),
  defaultApiKey: process.env.DEFAULT_API_KEY ?? "dev-openai-compatible-key",
  huaweiApiHost:
    process.env.HUAWEI_API_HOST ?? "https://ide.cn-north-4.myhuaweicloud.com",
  huaweiChatHost:
    process.env.HUAWEI_CHAT_HOST ??
    "https://snap-access.cn-north-4.myhuaweicloud.com",
  huaweiV2ChatPath:
    process.env.HUAWEI_V2_CHAT_PATH ?? "/api/v2/chat/completions",
  huaweiIamHost:
    process.env.HUAWEI_IAM_HOST ?? "https://iam.cn-north-4.myhuaweicloud.com",
  huaweiRedirectHost:
    process.env.HUAWEI_REDIRECT_HOST ??
    "https://devcloud.cn-north-4.huaweicloud.com/codeartside",
  enableRefreshTask: (process.env.ENABLE_REFRESH_TASK ?? "true") !== "false",
  ideVersion: process.env.IDE_VERSION ?? "26.3.11",
  pluginVersion: process.env.PLUGIN_VERSION ?? "26.3.5",
  huaweiGptsUrl: process.env.HUAWEI_GPTS_URL ?? "", // empty = derive from chatHost
  isInnerVersion: (process.env.HUAWEI_IS_INNER_VERSION ?? "false") === "true",
  huaweiAgentId:
    process.env.HUAWEI_AGENT_ID ?? "", // empty = derive from isInnerVersion
  modelCacheTtl: Number(process.env.MODEL_CACHE_TTL ?? 300),
  upstreamPromptTokenLimit: Number(process.env.UPSTREAM_PROMPT_TOKEN_LIMIT ?? 196608),
  upstreamMaxConcurrency: Number(process.env.UPSTREAM_MAX_CONCURRENCY ?? 3),
  upstreamQueueWaitTimeoutMs: Number(process.env.UPSTREAM_QUEUE_WAIT_TIMEOUT_MS ?? 120_000),
  upstreamConcurrencyRetryMax: Number(process.env.UPSTREAM_CONCURRENCY_RETRY_MAX ?? 2),
  upstreamConcurrencyRetryDelayMs: Number(
    process.env.UPSTREAM_CONCURRENCY_RETRY_DELAY_MS ?? 1500,
  ),
  upstreamMinConcurrency: Number(process.env.UPSTREAM_MIN_CONCURRENCY ?? 1),
  upstreamConcurrencyRecoverMs: Number(
    process.env.UPSTREAM_CONCURRENCY_RECOVER_MS ?? 60_000,
  ),
};

/** Whether the process is running in production mode. */
export const isProduction = config.nodeEnv === "production";

/** Whether the encryption key is the hardcoded dev fallback. */
export const isDevEncryptionKey = !isProduction && config.encryptionKey === "dev-only-32-byte-encryption-key!";

/** Rate limit: max chat completion requests per window per API key. */
export const rateLimitChatMax = Number(process.env.RATE_LIMIT_CHAT_MAX ?? 60);

/** Rate limit: max model list requests per window per API key. */
export const rateLimitModelsMax = Number(process.env.RATE_LIMIT_MODELS_MAX ?? 120);

/** Rate limit: max requests per window per source IP, covering routes without a dedicated limiter. */
export const rateLimitGlobalMax = Number(process.env.RATE_LIMIT_GLOBAL_MAX ?? 300);

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 回调 `redirect` 参数允许的主机白名单（开放重定向防护，CWE-601）。
 * 默认包含华为云重定向主机与本地回环地址（IDE 本地回调），
 * 可通过 `REDIRECT_ALLOWED_HOSTS` 追加（逗号分隔）。
 */
export const redirectAllowedHosts = new Set<string>(
  [
    hostnameOf(config.huaweiRedirectHost),
    "127.0.0.1",
    "localhost",
    ...(process.env.REDIRECT_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase()),
  ].filter((host): host is string => !!host),
);

/** Upstream HTTPS request timeout in milliseconds (default: 120s). */
export const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 120_000);

/** Whether this node is the master node for refresh tasks (default: true). */
export const isMasterNode = (process.env.IS_MASTER_NODE ?? "true") === "true";

/**
 * Derive the GPTs (agent-center) URL from config.
 * If HUAWEI_GPTS_URL is set explicitly, use that.
 * Otherwise, derive from HUAWEI_CHAT_HOST based on isInnerVersion:
 *   - Internal: {chatHost}/PromptCenterService/v1/agent-center/agents
 *   - External: {chatHost}/v1/agent-center/agents
 */
/**
 * Derive the upstream chat endpoint URL.
 * Always the OpenAI-compatible v2 channel — the CodeArts-native /v1/chat/chat
 * channel does not support glm-5.3.
 */
export function getChatUrl(): string {
  const base = config.huaweiChatHost.replace(/\/$/, "");
  const path = config.huaweiV2ChatPath.startsWith("/")
    ? config.huaweiV2ChatPath
    : `/${config.huaweiV2ChatPath}`;
  return `${base}${path}`;
}

/**
 * Derive the GPTs (agent-center) URL from config.
 * If HUAWEI_GPTS_URL is set explicitly, use that.
 * Otherwise, derive from HUAWEI_CHAT_HOST based on isInnerVersion:
 *   - Internal: {chatHost}/PromptCenterService/v1/agent-center/agents
 *   - External: {chatHost}/v1/agent-center/agents
 */
export function getGptsUrl(): string {
  if (config.huaweiGptsUrl) return config.huaweiGptsUrl;
  const base = config.huaweiChatHost.replace(/\/$/, "");
  return config.isInnerVersion
    ? `${base}/PromptCenterService/v1/agent-center/agents`
    : `${base}/v1/agent-center/agents`;
}

/**
 * Derive the agent ID from config.
 * If HUAWEI_AGENT_ID is set explicitly, use that.
 * Otherwise, derive from isInnerVersion:
 *   - Internal: "CodeMate" (brandName with spaces replaced by underscores)
 *   - External: "Pangu_Doer_in_CodeArts"
 */
export function getAgentId(): string {
  if (config.huaweiAgentId) return config.huaweiAgentId;
  return config.isInnerVersion ? "CodeMate" : "Pangu_Doer_in_CodeArts";
}
