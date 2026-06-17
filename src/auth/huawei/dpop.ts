/**
 * DPoP (Demonstration of Proof-of-Possession) 实现。
 *
 * 逆向自上游 huaweicloud.authentication v5.0.2。
 * 使用 jose 库（与上游一致）。
 *
 * 上游 import map:
 *   jose.generateKeyPair + jose.exportJWK → generateDpopKeyPair
 *   jose.importJWK + jose.SignJWT       → generateDpopJWE (生成 DPoP proof JWT)
 *   crypto-js.WordArray.random          → generateDpopPayload 的 jti
 */

import { randomBytes } from "crypto";
import {
  generateKeyPair,
  exportJWK,
  importJWK,
  SignJWT,
  type JWK,
} from "jose";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DpopKeyPair {
  privateKeyJwk: JWK;
  publicKeyJwk: JWK;
}

export interface DpopPayload {
  htm: string;  // HTTP Method
  htu: string;  // HTTP URI
  iat: number;  // Issued At (Unix seconds)
  jti: string;  // JWT ID (unique, 64-char hex)
}

// ---------------------------------------------------------------------------
// Key Generation
// ---------------------------------------------------------------------------

/**
 * 生成 DPoP 密钥对（ECDSA P-256 / ES256）。
 *
 * 逆向自上游 generateDpopKeyPair()：
 * - 使用 ES256 算法（ECDSA with P-256 curve）
 * - 密钥必须 extractable（可导出为 JWK）
 * - 返回 JWK 格式的公钥和私钥
 */
export async function generateDpopKeyPair(): Promise<DpopKeyPair> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", {
    extractable: true,
    crv: "P-256",
  });
  const publicKeyJwk = await exportJWK(publicKey);
  const privateKeyJwk = await exportJWK(privateKey);
  return { privateKeyJwk, publicKeyJwk };
}

// ---------------------------------------------------------------------------
// Payload Generation
// ---------------------------------------------------------------------------

/**
 * 生成 DPoP payload。
 *
 * 逆向自上游 generateDpopPayload()：
 * - htm: HTTP method (e.g., "POST")
 * - htu: HTTP URI (full URL)
 * - iat: 当前 Unix 时间戳（秒）
 * - jti: 64 字符随机 hex 字符串（32 字节）
 */
export function generateDpopPayload(httpMethod: string, httpUri: string): DpopPayload {
  return {
    htm: httpMethod,
    htu: httpUri,
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(32).toString("hex"),
  };
}

// ---------------------------------------------------------------------------
// DPoP Proof (JWT) Generation
// ---------------------------------------------------------------------------

/**
 * 生成 DPoP JWT（JWS Compact Serialization）。
 *
 * 逆向自上游 generateDpopJWE()：
 * - Header: { alg: "ES256", typ: "dpop+jwt", jwk: publicKeyJwk }
 * - Payload: { htm, htu, iat, jti }
 * - 签名: 使用 jose.SignJWT（ES256 / ECDSA P-256）
 *
 * 输出格式: header.payload.signature (Base64URL encoded)
 */
export async function generateDpopProof(
  keyPair: DpopKeyPair,
  payload: DpopPayload,
): Promise<string> {
  // 导入私钥（不可 extractable，与上游一致）
  const privateKey = await importJWK(keyPair.privateKeyJwk, "ES256", {
    extractable: false,
  });

  // 生成 JWT
  const jwt = await new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({
      alg: "ES256",
      typ: "dpop+jwt",
      jwk: keyPair.publicKeyJwk as unknown as Record<string, unknown>,
    })
    .sign(privateKey);

  return jwt;
}
