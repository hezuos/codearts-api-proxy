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
   * Whether full-context injection is enabled on cache miss (default: false).
   * When enabled, the proxy folds the complete client message history into a
   * single text message and injects it upstream instead of forwarding only the
   * last user message. See docs/spike-full-context-injection.md for the spike
   * validation and openspec/changes/full-context-injection-on-cache-miss/design.md
   * for the design (D1 trigger conditions, D2 fold format, D3 truncation).
   */
  fullContextInjectionEnabled: boolean;
  /**
   * Maximum character budget for the folded full-context injection text (default: 8000).
   * Conservative default aligns with the smallest observed upstream context window
   * (openpangu-2.0-flash ~9K tokens). Override per model via
   * FULL_CONTEXT_MAX_CHARS_BY_MODEL JSON env var, e.g.
   * `{"GLM-5.2":500000,"openpangu-2.0-pro":180000}`.
   * See docs/spike-full-context-injection.md §3 for measured per-model limits.
   */
  fullContextMaxChars: number;
  /**
   * Per-model overrides for fullContextMaxChars (JSON map of model_id → char budget).
   * Empty object = use fullContextMaxChars for all models.
   */
  fullContextMaxCharsByModel: Record<string, number>;
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
  fullContextInjectionEnabled:
    (process.env.FULL_CONTEXT_INJECTION_ENABLED ?? "false") === "true",
  fullContextMaxChars: Number(process.env.FULL_CONTEXT_MAX_CHARS ?? 8000),
  fullContextMaxCharsByModel: parseMaxCharsByModel(
    process.env.FULL_CONTEXT_MAX_CHARS_BY_MODEL ?? "",
  ),
};

/**
 * Parse the FULL_CONTEXT_MAX_CHARS_BY_MODEL JSON env var into a model_id → char budget map.
 * Returns empty object on missing/invalid input (falls back to fullContextMaxChars for all models).
 */
function parseMaxCharsByModel(raw: string): Record<string, number> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        result[key] = Math.floor(value);
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** Whether the process is running in production mode. */
export const isProduction = config.nodeEnv === "production";

/** Whether the encryption key is the hardcoded dev fallback. */
export const isDevEncryptionKey = !isProduction && config.encryptionKey === "dev-only-32-byte-encryption-key!";

/** Rate limit: max chat completion requests per window per API key. */
export const rateLimitChatMax = Number(process.env.RATE_LIMIT_CHAT_MAX ?? 60);

/** Rate limit: max model list requests per window per API key. */
export const rateLimitModelsMax = Number(process.env.RATE_LIMIT_MODELS_MAX ?? 120);

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
