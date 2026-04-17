export interface AppConfig {
  port: number;
  callbackPort: number;
  nodeEnv: string;
  requestBodyLimit: string;
  dataDir: string;
  authStoreFile: string;
  conversationStoreFile: string;
  sessionStoreFile: string;
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
}

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config: AppConfig = {
  port: Number(process.env.PORT ?? 1455),
  callbackPort: Number(process.env.CALLBACK_PORT ?? process.env.PORT ?? 1455),
  nodeEnv: process.env.NODE_ENV ?? "development",
  requestBodyLimit: process.env.REQUEST_BODY_LIMIT ?? "10mb",
  dataDir: process.env.DATA_DIR ?? "data",
  authStoreFile: process.env.AUTH_STORE_FILE ?? "data/auth-store.json",
  conversationStoreFile:
    process.env.CONVERSATION_STORE_FILE ?? "data/conversation-store.json",
  sessionStoreFile:
    process.env.SESSION_STORE_FILE ?? "data/huawei-sessions.json",
  encryptionKey: requireEnv(
    "ENCRYPTION_KEY",
    "dev-only-32-byte-encryption-key!",
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
};
