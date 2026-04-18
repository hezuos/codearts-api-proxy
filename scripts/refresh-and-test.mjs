#!/usr/bin/env node
/**
 * refresh-and-test.mjs — Refresh credentials then send chat request
 *
 * 1. Read saved session
 * 2. Call /v2/login/refresh to get fresh credentials
 * 3. Send chat request with fresh credentials
 */

import crypto from "crypto";
import https from "https";
import { readFileSync, writeFileSync } from "fs";
import { DEFAULT_TOOLS } from "./tools-definition.mjs";

// ---------------------------------------------------------------------------
// Signing (for refresh endpoint — uses different signed headers!)
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

/**
 * Build Authorization for /v2/login/refresh endpoint.
 * APIG requires x-sdk-date and host to be signed.
 * Returns { Authorization, "X-Sdk-Date" } headers.
 */
function buildRefreshAuth(accessKey, secretKey, securityToken, body) {
  const now = sdkDateFormat(new Date());
  const host = "ide.cn-north-4.myhuaweicloud.com";

  // All headers that participate in signing (sorted alphabetically)
  const headersToSign = {
    "content-type": "application/json",
    host: host,
    "x-sdk-date": now,
    "x-security-token": securityToken,
  };

  const sortedKeys = Object.keys(headersToSign).sort();
  const signedHeaderNames = sortedKeys.join(";");
  const canonicalHeaders = sortedKeys
    .map((k) => `${k}:${headersToSign[k]}\n`)
    .join("");

  // APIG normalizes the path to include a trailing slash
  const canonicalRequest = [
    "POST",
    "/v2/login/refresh/",
    "",
    canonicalHeaders,
    signedHeaderNames,
    sha256Hex(body),
  ].join("\n");

  const stringToSign = [
    "SDK-HMAC-SHA256",
    now,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = hmacSha256(secretKey, stringToSign).toString("hex");
  const authorization = `SDK-HMAC-SHA256 Access=${accessKey}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`;

  return { Authorization: authorization, "X-Sdk-Date": now };
}

/**
 * Standard SDK-HMAC-SHA256 signing for Huawei Cloud API (APIG).
 * Only signs: host, x-sdk-date, content-type, x-security-token (if present).
 */
function signChatRequest(method, urlStr, headers, body, credentials) {
  const url = new URL(urlStr);
  const sdkDate = sdkDateFormat(new Date());

  // Only sign essential headers (like the real SDK AKSKSigner does)
  const headersToSign = {
    host: url.host,
    "x-sdk-date": sdkDate,
  };

  // Add content-type if present
  if (headers["Content-Type"]) {
    headersToSign["content-type"] = headers["Content-Type"];
  }

  // Add security token if present
  if (credentials.securityToken) {
    headersToSign["x-security-token"] = credentials.securityToken;
  }

  const sortedKeys = Object.keys(headersToSign).sort();
  const signedHeaderNames = sortedKeys.join(";");
  const canonicalHeaders = sortedKeys
    .map((k) => `${k}:${headersToSign[k]}\n`)
    .join("");

  // APIG normalizes URIs to have trailing slashes
  let canonicalUri = url.pathname || "/";
  if (!canonicalUri.endsWith("/")) canonicalUri += "/";
  const hashedPayload = sha256Hex(body ?? "");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    "", // no query string
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
    ...(credentials.securityToken
      ? { "X-Security-Token": credentials.securityToken }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function httpsRequest(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, data }),
      );
    });

    req.on("error", reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const sessionPath = process.argv.includes("--session")
    ? process.argv[process.argv.indexOf("--session") + 1]
    : "scripts/session-decrypted.json";

  const session = JSON.parse(readFileSync(sessionPath, "utf8"));
  console.log("=== Current session ===");
  console.log(`  AK: ${session.accessKey}`);
  console.log(`  SK: ${session.secretKey.substring(0, 4)}****`);
  console.log(
    `  ST: ${session.securitytoken ? session.securitytoken.substring(0, 30) + "..." : "(none)"}`,
  );
  console.log(`  expires_at: ${session.expires_at}`);

  // Step 1: Try refresh
  console.log("\n=== Step 1: Refresh credentials ===");
  const refreshBody = JSON.stringify({ duration_seconds: 86400 });
  const refreshUrl =
    "https://ide.cn-north-4.myhuaweicloud.com/v2/login/refresh";
  const authHeaders = buildRefreshAuth(
    session.accessKey,
    session.secretKey,
    session.securitytoken,
    refreshBody,
  );

  const refreshHeaders = {
    "Content-Type": "application/json",
    "X-Security-Token": session.securitytoken,
    "Access-Key": session.accessKey,
    ...authHeaders,
  };

  console.log(`POST ${refreshUrl}`);
  const refreshResult = await httpsRequest(
    "POST",
    refreshUrl,
    refreshHeaders,
    refreshBody,
  );
  console.log(`Status: ${refreshResult.status}`);
  console.log(`Response: ${refreshResult.data.substring(0, 500)}`);

  if (refreshResult.status !== 200) {
    console.error("Refresh failed! Cannot proceed.");
    console.log("\nFull response:", refreshResult.data);
    return;
  }

  // Parse refresh response and extract new credentials
  const refreshData = JSON.parse(refreshResult.data);
  console.log("Refresh response keys:", Object.keys(refreshData));

  const credential =
    refreshData.result?.credential ||
    refreshData.credential ||
    refreshData.credentials ||
    refreshData;
  const newSession = {
    ...session,
    accessKey: credential.access || session.accessKey,
    secretKey: credential.secret || session.secretKey,
    securitytoken: credential.securitytoken || session.securitytoken,
    expires_at: credential.expires_at || session.expires_at,
  };

  console.log(`\n=== New credentials ===`);
  console.log(`  AK: ${newSession.accessKey}`);
  console.log(`  SK: ${newSession.secretKey.substring(0, 4)}****`);
  console.log(`  ST: ${newSession.securitytoken.substring(0, 30)}...`);
  console.log(`  expires_at: ${newSession.expires_at}`);

  // Save updated session
  writeFileSync(sessionPath, JSON.stringify(newSession, null, 2));
  console.log(`Saved updated session to: ${sessionPath}`);

  // Step 2: Check policy/bundle to see available models and config
  console.log("\n=== Step 2: Check policy/bundle ===");
  const policyUrl =
    "https://snap-access.cn-north-4.myhuaweicloud.com/v1/policy/bundle";
  const policyBody = JSON.stringify({});
  const policyBaseHeaders = {
    "Content-Type": "application/json",
    "Agent-Type": "ChatAgent",
    "ide-name": "CodeArts Agent",
    "ide-version": "26.3.11",
    "plugin-name": "codearts-snap_vscode",
    "plugin-version": "26.3.5",
    client_version: "26.3.5",
  };
  const policyCreds = {
    accessKey: newSession.accessKey,
    secretKey: newSession.secretKey,
    securityToken: newSession.securitytoken,
  };
  const policySignedHeaders = signChatRequest(
    "POST",
    policyUrl,
    policyBaseHeaders,
    policyBody,
    policyCreds,
  );
  const policyHeaders = { ...policyBaseHeaders, ...policySignedHeaders };
  console.log(`POST ${policyUrl}`);
  const policyResult = await httpsRequest(
    "POST",
    policyUrl,
    policyHeaders,
    policyBody,
  );
  console.log(`Status: ${policyResult.status}`);
  if (policyResult.status === 200) {
    try {
      const policyData = JSON.parse(policyResult.data);
      console.log("Policy keys:", Object.keys(policyData));
      // Show models if available
      if (policyData.result?.models || policyData.models) {
        console.log(
          "Models:",
          JSON.stringify(
            policyData.result?.models || policyData.models,
            null,
            2,
          ).substring(0, 1000),
        );
      }
      // Show full response truncated
      console.log(
        "Full policy response (truncated):",
        policyResult.data.substring(0, 2000),
      );
    } catch {
      console.log("Response:", policyResult.data.substring(0, 2000));
    }
  } else {
    console.log("Response:", policyResult.data.substring(0, 500));
  }

  // Step 3: Send chat request with new credentials
  console.log("\n=== Step 3: Send chat request ===");
  const chatUrl =
    "https://snap-access.cn-north-4.myhuaweicloud.com/v1/chat/chat";
  const chatId = crypto.randomUUID().replace(/-/g, "");
  const prompt = "你好，请简短回答：1+1等于几？";
  const userName = session.account?.label || "proxy-test";
  const chatBody = JSON.stringify({
    chat_id: chatId,
    messages: [{ type: "text", content: prompt }],
    client: "IDE",
    task: "plan-execute",
    task_parameters: {
      codebase_search: false,
      preferred_language: "zh-cn",
      enable_code_interpreter: false,
      projectLevelPrompt: "",
      isSubAgent: false,
      tools: DEFAULT_TOOLS,
      environmentDetails: {
        osVersion: "win32",
        currentDate: new Date()
          .toISOString()
          .replace("T", "T")
          .replace("Z", ""),
        currentWorkingDirectory: "d:\\proxy-test",
      },
      routerVersion: "v2",
      isNewClient: true,
      features: { support_end_tag: true },
      contexts: [],
      expert_rules: [],
      ide: "CodeArts Agent",
    },
    batch_task_parameters: [],
    attempt: 1,
    user_id: userName,
    agent_id: "CodeAgent",
    parent_message_id: crypto.randomUUID().replace(/-/g, ""),
    is_delta_response: true,
    model_id: "Glm-4.7-internal",
  });

  const traceId = crypto.randomUUID().replace(/-/g, "");
  const chatBaseHeaders = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Agent-Type": "ChatAgent",
    "X-Language": "zh-CN",
    "x-snap-traceid": traceId,
    client_version: "26.3.5",
    "plugin-name": "codearts-snap_vscode",
    "plugin-version": "26.3.5",
    "ide-name": "CodeArts Agent",
    "ide-version": "26.3.11",
    is_confidential: "false",
    "heartbeat-enable": "true",
  };

  const chatCredentials = {
    accessKey: newSession.accessKey,
    secretKey: newSession.secretKey,
    securityToken: newSession.securitytoken,
  };

  const signedHeaders = signChatRequest(
    "POST",
    chatUrl,
    chatBaseHeaders,
    chatBody,
    chatCredentials,
  );

  const allHeaders = {
    ...chatBaseHeaders,
    ...signedHeaders,
  };

  console.log(`POST ${chatUrl}`);
  console.log("Headers:");
  for (const [k, v] of Object.entries(allHeaders)) {
    const display =
      String(v).length > 80 ? String(v).substring(0, 80) + "..." : v;
    console.log(`  ${k}: ${display}`);
  }

  const chatResult = await httpsRequest("POST", chatUrl, allHeaders, chatBody);
  console.log(`\nStatus: ${chatResult.status}`);
  console.log("Response headers:");
  for (const [k, v] of Object.entries(chatResult.headers)) {
    console.log(`  ${k}: ${v}`);
  }

  console.log("\nRaw response:");
  console.log(chatResult.data.substring(0, 2000));

  // Parse SSE events
  if (chatResult.data) {
    console.log("\n--- Parsed SSE content ---");
    const lines = chatResult.data.split("\n");
    let fullText = "";
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const jsonStr = line.substring(5).trim();
        if (jsonStr && jsonStr !== "[DONE]") {
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.text) fullText += parsed.text;
            if (parsed.error_code && parsed.error_code !== "0") {
              console.log(
                `Error: code=${parsed.error_code}, text=${parsed.text}`,
              );
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (fullText) {
      console.log("Full response text:", fullText);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
