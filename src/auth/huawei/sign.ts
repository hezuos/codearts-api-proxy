/**
 * SDK-HMAC-SHA256 signing for Huawei Cloud API requests.
 *
 * Implements the standard Huawei Cloud API signature algorithm used by
 * GlobalCredentials in the HC (Huawei Cloud commercial) mode.
 *
 * Reference: extension.js AKSKSigner (System A) and CCu class (System B).
 * Both produce: Authorization: SDK-HMAC-SHA256 Access={AK}, SignedHeaders={...}, Signature={...}
 */
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SigningCredentials {
  accessKey: string;
  secretKey: string;
  securityToken?: string;
}

export interface SignableRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Headers returned by signRequest that the caller must merge into the
 * outgoing HTTP request.
 */
export interface SignedHeaders {
  Authorization: string;
  "X-Sdk-Date": string;
  Host: string;
  "X-Security-Token"?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key: Buffer | string, value: string): Buffer {
  return crypto.createHmac("sha256", key).update(value).digest();
}

/**
 * Format a Date as `YYYYMMDDTHHMMSSZ` (ISO 8601 basic, no separators).
 * This is the format expected by the Huawei Cloud `X-Sdk-Date` header.
 */
function sdkDateFormat(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

// ---------------------------------------------------------------------------
// Main signing function
// ---------------------------------------------------------------------------

/**
 * Sign an HTTP request using SDK-HMAC-SHA256.
 *
 * @returns An object of headers the caller should **merge** into the actual
 *          request headers (Authorization, X-Sdk-Date, Host, and optionally
 *          X-Security-Token).
 *
 * The signing follows the canonical request format:
 * ```
 * HTTPMethod\n
 * CanonicalURI\n
 * CanonicalQueryString\n
 * CanonicalHeaders\n
 * SignedHeaders\n
 * HashedPayload
 * ```
 *
 * String to sign:
 * ```
 * SDK-HMAC-SHA256\n
 * X-Sdk-Date\n
 * SHA256(CanonicalRequest)
 * ```
 */
export function signRequest(
  request: SignableRequest,
  credentials: SigningCredentials,
): SignedHeaders {
  const url = new URL(request.url);
  const sdkDate = sdkDateFormat(new Date());

  // --- 1. Collect all headers to sign (lowercase keys, trimmed values) ------
  const headersToSign: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) {
    headersToSign[k.toLowerCase().trim()] = v.trim();
  }

  // Mandatory signing headers
  headersToSign["host"] = url.host;
  headersToSign["x-sdk-date"] = sdkDate;
  if (credentials.securityToken) {
    headersToSign["x-security-token"] = credentials.securityToken;
  }

  // --- 2. Sort headers by key -----------------------------------------------
  const sortedKeys = Object.keys(headersToSign).sort();
  const signedHeaderNames = sortedKeys.join(";");
  const canonicalHeaders = sortedKeys
    .map((k) => `${k}:${headersToSign[k]}\n`)
    .join("");

  // --- 3. Canonical query string (sorted by key) ---------------------------
  const queryEntries = [...url.searchParams.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const canonicalQueryString = queryEntries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  // --- 4. Canonical URI (pathname as-is, with trailing slash for APIG) ------
  let canonicalUri = url.pathname || "/";
  if (!canonicalUri.endsWith("/")) canonicalUri += "/";

  // --- 5. Hash the payload --------------------------------------------------
  const hashedPayload = sha256Hex(request.body ?? "");

  // --- 6. Build canonical request -------------------------------------------
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaderNames,
    hashedPayload,
  ].join("\n");

  // --- 7. Build string to sign ----------------------------------------------
  const stringToSign = [
    "SDK-HMAC-SHA256",
    sdkDate,
    sha256Hex(canonicalRequest),
  ].join("\n");

  // --- 8. Compute signature -------------------------------------------------
  const signature = hmacSha256(credentials.secretKey, stringToSign).toString(
    "hex",
  );

  // --- 9. Build Authorization header value ----------------------------------
  const authorization = `SDK-HMAC-SHA256 Access=${credentials.accessKey}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`;

  // --- 10. Return headers to merge ------------------------------------------
  const result: SignedHeaders = {
    Authorization: authorization,
    "X-Sdk-Date": sdkDate,
    Host: url.host,
  };
  if (credentials.securityToken) {
    result["X-Security-Token"] = credentials.securityToken;
  }

  return result;
}
