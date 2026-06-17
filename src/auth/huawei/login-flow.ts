/**
 * 华为云登录流程（v5.0.2 新版 OAuth2 + PKCE）。
 *
 * 新版使用 OAuth2 授权码流程 + PKCE 安全机制：
 * - code_verifier: 128 字符随机 hex 字符串（64 字节）
 * - code_challenge: SHA-256 哈希后的 base64url 编码
 * - Token 端点: https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
 * - 回调路径: /oauth/callback
 * - DPoP: ECDSA P-256 密钥对，用于 token exchange 签名
 */

import { randomBytes, createHash } from "crypto";
import { config } from "../../config";
import { generateDpopKeyPair, type DpopKeyPair } from "./dpop";

/** PKCE 配置（逆向自上游 v5.0.2） */
const PKCE_VERIFIER_LENGTH = 128; // 64 bytes random, hex encoded = 128 chars
const PKCE_CODE_CHALLENGE_METHOD = "SHA-256";

/** OAuth2 端点（逆向自上游 v5.0.2 配置） */
const PORTAL_HOST = "https://codearts.huaweicloud.com/portal";
const IAM_STS_HOST = "https://sts.cn-north-4.myhuaweicloud.com";
const IAM_TOKEN_API = "/v1/oauth2/tokens";
const AUTH_REDIRECT_URL = "/oauth/callback";

/** 客户端标识（逆向自上游 v5.0.2：CLIENT_ID = env.uriScheme） */
const CLIENT_ID = "codearts-agent";

/** 插件信息（逆向自上游 v5.0.2） */
const LOGIN_PLUGIN_NAME = "snap_AIIDE";
const EXTENSION_VERSION = "5.0.2";

export interface PKCEPair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

export interface HuaweiLoginFlow {
  ticketId: string;
  loginUrl: string;
  state: string;
  expiresAt: Date;
  /** PKCE 密钥对（需要存储，token exchange 时使用） */
  pkcePair: PKCEPair;
  /** DPoP 密钥对（需要存储，token exchange 时使用） */
  dpopKeyPair: DpopKeyPair;
}

/**
 * 生成 PKCE code_verifier（128 字符 hex 字符串）。
 *
 * 逆向自上游：PKCEGenerator.VERIFIER_LENGTH = 128
 * randomBytes(64) → toString("hex") → 128 字符
 */
function generateCodeVerifier(): string {
  return randomBytes(PKCE_VERIFIER_LENGTH / 2).toString("hex");
}

/**
 * 从 code_verifier 生成 code_challenge（SHA-256 + base64url）。
 *
 * 逆向自上游：PKCEGenerator.generateCodeChallenge()
 * SHA256(verifier) → base64 → 替换 +/= 为 -_ (base64url)
 */
function generateCodeChallenge(verifier: string): string {
  const hash = createHash("sha256").update(verifier).digest("base64");
  // 转换为 base64url 格式（逆向自上游 base64ToBase64Url）
  return hash.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * 生成 PKCE 密钥对。
 */
function generatePKCEPair(): PKCEPair {
  const codeVerifier = generateCodeVerifier();
  return {
    codeVerifier,
    codeChallenge: generateCodeChallenge(codeVerifier),
    codeChallengeMethod: PKCE_CODE_CHALLENGE_METHOD,
  };
}

/**
 * 创建华为云登录流程（v5.0.2 新版 OAuth2 + PKCE + DPoP）。
 *
 * 逆向自上游 LoginBackend.buildLoginUrl() + initLoginContext()：
 * - 生成 PKCE 密钥对
 * - 生成 DPoP 密钥对（ECDSA P-256）
 * - 构建登录 URL
 */
export async function createHuaweiLoginFlow(callbackPort: number): Promise<HuaweiLoginFlow> {
  const ticketId = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  // PKCE 参数
  const pkcePair = generatePKCEPair();

  // DPoP 密钥对（逆向自上游 initLoginContext）
  const dpopKeyPair = await generateDpopKeyPair();

  // 构建登录 URL（逆向自上游 buildLoginUrl）
  // 注意：必须包含 state 参数用于 OAuth2 CSRF 保护
  const params = new URLSearchParams({
    theme: "2",
    locale: "zh-cn",
    uri_scheme: CLIENT_ID,
    client_id: CLIENT_ID,
    port: String(callbackPort),
    code_challenge: pkcePair.codeChallenge,
    code_challenge_method: pkcePair.codeChallengeMethod,
    ticket_id: ticketId,
    state: ticketId,  // OAuth2 state 参数，用于 CSRF 保护和回调匹配
    "plugin-name": LOGIN_PLUGIN_NAME,
    "plugin-version": EXTENSION_VERSION,
  });

  const loginUrl = `${PORTAL_HOST}/authorize?${params.toString()}`;

  return {
    ticketId,
    loginUrl,
    state: ticketId,  // 使用 ticketId 作为 state
    expiresAt,
    pkcePair,
    dpopKeyPair,
  };
}

/**
 * 创建华为云登录流程（旧版兼容）。
 *
 * 旧版 URL 格式：https://devcloud.cn-north-4.huaweicloud.com/codeartside/redirect1
 */
export function createHuaweiLoginFlowLegacy(callbackPort: number): HuaweiLoginFlow {
  const ticketId = randomBytes(32).toString("hex");
  const state = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  const redirectUrl = `${config.huaweiRedirectHost}/redirect1?ticket_id=${ticketId}&theme=1&locale=zh-cn&version=3&uri_scheme=http&port=${callbackPort}&is_redirect=true`;

  return {
    ticketId,
    loginUrl: redirectUrl,
    state,
    expiresAt,
    pkcePair: {
      codeVerifier: "",
      codeChallenge: "",
      codeChallengeMethod: "",
    },
    // 旧版不需要 DPoP，但需要提供空对象以满足接口
    dpopKeyPair: {
      privateKeyJwk: { kty: "", crv: "", x: "", y: "", d: "" },
      publicKeyJwk: { kty: "", crv: "", x: "", y: "" },
    },
  };
}

/**
 * 获取 OAuth2 Token 端点 URL。
 */
export function getTokenEndpoint(): string {
  return `${IAM_STS_HOST}${IAM_TOKEN_API}`;
}

/**
 * 获取 OAuth2 回调路径。
 */
export function getAuthRedirectUrl(): string {
  return AUTH_REDIRECT_URL;
}

/**
 * 获取客户端 ID。
 */
export function getClientId(): string {
  return CLIENT_ID;
}

/**
 * 获取 IAM STS 主机。
 */
export function getIamStsHost(): string {
  return IAM_STS_HOST;
}

/**
 * 获取 PKCE 配置常量（用于测试）。
 */
export function getPKCEConstants() {
  return {
    VERIFIER_LENGTH: PKCE_VERIFIER_LENGTH,
    CODE_CHALLENGE_METHOD: PKCE_CODE_CHALLENGE_METHOD,
  };
}
