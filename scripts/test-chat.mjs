#!/usr/bin/env node
/**
 * test-chat.mjs — 最小可行聊天请求测试脚本
 *
 * 使用解密的 AK/SK/SecurityToken 进行 SDK-HMAC-SHA256 签名后，
 * 向 snap-access 发送一个最小聊天请求并打印原始 SSE 响应。
 *
 * 用法 (PowerShell):
 *   $env:HW_AK="your-access-key"
 *   $env:HW_SK="your-secret-key"
 *   $env:HW_ST="your-security-token"
 *   node scripts/test-chat.mjs
 *
 * 或者传入 session JSON 文件:
 *   node scripts/test-chat.mjs --session scripts/session-decrypted.json
 *
 * session JSON 文件格式:
 *   { "accessKey": "...", "secretKey": "...", "securitytoken": "..." }
 */

import crypto from "crypto";
import https from "https";
import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// SDK-HMAC-SHA256 signing (standalone, same logic as src/auth/huawei/sign.ts)
// ---------------------------------------------------------------------------

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function sdkDateFormat(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signRequest(method, urlStr, headers, body, credentials) {
  const url = new URL(urlStr);
  const sdkDate = sdkDateFormat(new Date());

  // Collect headers to sign (lowercase keys)
  const headersToSign = {};
  for (const [k, v] of Object.entries(headers)) {
    headersToSign[k.toLowerCase().trim()] = String(v).trim();
  }

  // Mandatory signing headers
  headersToSign["host"] = url.host;
  headersToSign["x-sdk-date"] = sdkDate;
  if (credentials.securityToken) {
    headersToSign["x-security-token"] = credentials.securityToken;
  }

  // Sort by key
  const sortedKeys = Object.keys(headersToSign).sort();
  const signedHeaderNames = sortedKeys.join(";");
  const canonicalHeaders = sortedKeys
    .map((k) => `${k}:${headersToSign[k]}\n`)
    .join("");

  // Query string (sorted)
  const queryEntries = [...url.searchParams.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const canonicalQueryString = queryEntries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalUri = url.pathname || "/";
  const hashedPayload = sha256Hex(body ?? "");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaderNames,
    hashedPayload,
  ].join("\n");

  const stringToSign = [
    "SDK-HMAC-SHA256",
    sdkDate,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = hmacSha256(credentials.secretKey, stringToSign).toString(
    "hex",
  );
  const authorization = `SDK-HMAC-SHA256 Access=${credentials.accessKey}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`;

  return {
    Authorization: authorization,
    "X-Sdk-Date": sdkDate,
    Host: url.host,
    ...(credentials.securityToken
      ? { "X-Security-Token": credentials.securityToken }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Credential loading
// ---------------------------------------------------------------------------

function loadCredentials() {
  // Check for --session flag
  const sessionIdx = process.argv.indexOf("--session");
  if (sessionIdx !== -1 && process.argv[sessionIdx + 1]) {
    const sessionFile = process.argv[sessionIdx + 1];
    console.log(`Loading session from: ${sessionFile}`);
    const data = JSON.parse(readFileSync(sessionFile, "utf8"));
    return {
      accessKey: data.accessKey,
      secretKey: data.secretKey,
      securityToken: data.securitytoken || data.securityToken,
    };
  }

  // Fall back to environment variables
  const ak = process.env.HW_AK;
  const sk = process.env.HW_SK;
  const st = process.env.HW_ST;

  if (!ak || !sk) {
    console.error(
      "Missing credentials. Set HW_AK, HW_SK, HW_ST env vars or use --session <file>",
    );
    process.exit(1);
  }

  return { accessKey: ak, secretKey: sk, securityToken: st };
}

// ---------------------------------------------------------------------------
// Build chat request body (minimal)
// ---------------------------------------------------------------------------

function buildChatBody(prompt) {
  const chatId = crypto.randomUUID().replace(/-/g, "");
  return {
    chat_id: chatId,
    messages: [
      {
        type: "text",
        value: { input: prompt },
      },
    ],
    client: "IDE",
    task: "chat",
    task_parameters: {},
    batch_task_parameters: [],
    attempt: 0,
    user_id: "proxy-test",
    trigger_mode: "COMMENT_SLASH",
    is_delta_response: true,
    model_id: "GLM-5.1",
    agent_id: "CodeAgent",
  };
}

// ---------------------------------------------------------------------------
// Send SSE request via native https
// ---------------------------------------------------------------------------

function sendSSERequest(urlStr, body, signedHeaders, allHeaders) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        ...allHeaders,
        ...signedHeaders,
      },
    };

    console.log("\n--- Request ---");
    console.log(`POST ${urlStr}`);
    console.log("Headers:");
    for (const [k, v] of Object.entries(options.headers)) {
      // Truncate long values for readability
      const display =
        String(v).length > 80 ? String(v).substring(0, 80) + "..." : v;
      console.log(`  ${k}: ${display}`);
    }
    console.log(`Body: ${body.substring(0, 200)}...`);
    console.log("\n--- Response ---");

    const req = https.request(options, (res) => {
      console.log(`Status: ${res.statusCode} ${res.statusMessage}`);
      console.log("Response Headers:");
      for (const [k, v] of Object.entries(res.headers)) {
        console.log(`  ${k}: ${v}`);
      }
      console.log("\nSSE Data:");

      let fullData = "";

      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        process.stdout.write(chunk);
        fullData += chunk;
      });
      res.on("end", () => {
        console.log("\n--- End of response ---");
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: fullData,
        });
      });
    });

    req.on("error", (err) => {
      console.error("Request error:", err.message);
      reject(err);
    });

    req.setTimeout(60000, () => {
      console.error("Request timed out (60s)");
      req.destroy();
    });

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const credentials = loadCredentials();
  console.log(`AK: ${credentials.accessKey}`);
  console.log(`SK: ${credentials.secretKey.substring(0, 4)}****`);
  console.log(
    `ST: ${credentials.securityToken ? credentials.securityToken.substring(0, 20) + "..." : "(none)"}`,
  );

  const prompt =
    process.argv.find(
      (a) =>
        !a.startsWith("--") &&
        !a.startsWith("node") &&
        !a.includes("test-chat"),
    ) || "你好，请简短回答：1+1等于几？";

  console.log(`\nPrompt: ${prompt}`);

  const chatBody = buildChatBody(prompt);
  const bodyStr = JSON.stringify(chatBody);

  const chatUrl =
    "https://snap-access.cn-north-4.myhuaweicloud.com/v1/chat/chat";
  const traceId = crypto.randomUUID().replace(/-/g, "");

  // Base headers (before signing)
  const baseHeaders = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Agent-Type": "ChatAgent",
    "x-snap-traceid": traceId,
    "x-auth-token": "", // empty in HC mode
    "heartbeat-enable": "true",
  };

  // Sign the request
  const signedHeaders = signRequest(
    "POST",
    chatUrl,
    baseHeaders,
    bodyStr,
    credentials,
  );

  // Merge and send
  const result = await sendSSERequest(
    chatUrl,
    bodyStr,
    signedHeaders,
    baseHeaders,
  );

  // Try to parse any SSE data lines
  if (result.data) {
    console.log("\n--- Parsed SSE events ---");
    const lines = result.data.split("\n");
    let eventCount = 0;
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const jsonStr = line.substring(5).trim();
        if (jsonStr && jsonStr !== "[DONE]") {
          try {
            const parsed = JSON.parse(jsonStr);
            eventCount++;
            if (parsed.text) {
              process.stdout.write(parsed.text);
            }
            if (parsed.error_code && parsed.error_code !== "0") {
              console.log(
                `\nError: code=${parsed.error_code}, text=${parsed.text}`,
              );
            }
          } catch {
            console.log(`  (unparseable): ${jsonStr.substring(0, 100)}`);
          }
        }
      }
    }
    console.log(`\n\nTotal SSE events: ${eventCount}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
