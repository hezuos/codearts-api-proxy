import { decryptString } from "../crypto/encryption";
import type { SigningCredentials } from "./sign";
import type { StoredHuaweiSession } from "./session-store";

/**
 * Extract signing credentials from a stored session.
 * Decrypts the secret key ciphertext and returns the full credential set.
 */
export function getCredentials(session: StoredHuaweiSession): SigningCredentials {
  if (!session.accessKey || !session.secretKeyCiphertext) {
    throw new Error("Session missing AK/SK credentials");
  }
  return {
    accessKey: session.accessKey,
    secretKey: decryptString(session.secretKeyCiphertext),
    securityToken: session.securityToken,
  };
}

// Re-export sign types for convenience
export { signRequest, type SigningCredentials } from "./sign";