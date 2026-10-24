import crypto from "crypto";
import { config } from "../../config";

const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  return crypto.createHash("sha256").update(config.encryptionKey).digest();
}

export function encryptString(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptString(cipherText: string): string {
  const payload = Buffer.from(cipherText, "base64");
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plain.toString("utf8");
}

/** 解开加密的敏感值（cookie 等）；缺失或解密失败返回 undefined。 */
export function tryDecryptString(
  cipherText: string | undefined,
): string | undefined {
  if (!cipherText) return undefined;
  try {
    return decryptString(cipherText);
  } catch {
    return undefined;
  }
}
