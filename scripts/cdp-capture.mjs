#!/usr/bin/env node
/**
 * cdp-capture.mjs — 一键抓包 CodeArts Agent 扩展的 HTTPS 请求
 *
 * 自动完成以下流程：
 *   1. 检测 VS Code 是否以 --inspect-extensions 模式启动
 *   2. 自动获取 CDP WebSocket URL
 *   3. 连接并安装请求拦截器
 *   4. 等待用户在 IDE 中触发请求，实时打印捕获结果
 *
 * 用法：
 *   # 方式 1：一键运行（自动检测端口和 session）
 *   node scripts/cdp-capture.mjs
 *
 *   # 方式 2：指定端口（自动获取 session ID）
 *   node scripts/cdp-capture.mjs --port 63732
 *
 *   # 方式 3：直接传 WebSocket URL（跳过自动检测）
 *   node scripts/cdp-capture.mjs ws://127.0.0.1:63732/xxxxxxxx
 *
 * 前置条件：
 *   VS Code 需要以调试模式启动：
 *     codearts-agent --inspect-extensions=63732
 *   或设置环境变量：
 *     $env:CODEARTS_INSPECT_PORT=63732
 */
import WebSocket from "ws";
import http from "http";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "captured-requests");

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 63732;
const CONNECT_TIMEOUT = 15000;
const POLL_INTERVAL = 2000; // 2s
const MAX_POLL_ROUNDS = 180; // 180 * 2s = 360s = 6 minutes

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);

  // 直接传 ws:// URL
  const wsUrl = args.find((a) => a.startsWith("ws://"));
  if (wsUrl) return { wsUrl };

  // --port <number>
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1 && args[portIdx + 1]) {
    return { port: Number(args[portIdx + 1]) };
  }

  // 环境变量
  if (process.env.CODEARTS_INSPECT_PORT) {
    return { port: Number(process.env.CODEARTS_INSPECT_PORT) };
  }

  // 默认自动检测
  return { port: DEFAULT_PORT };
}

// ---------------------------------------------------------------------------
// 自动获取 CDP WebSocket URL
// ---------------------------------------------------------------------------

function discoverWsUrl(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const targets = JSON.parse(data);
          if (!Array.isArray(targets) || targets.length === 0) {
            reject(new Error(`No CDP targets found on port ${port}`));
            return;
          }
          // 优先选 node 类型 target
          const nodeTarget =
            targets.find((t) => t.type === "node") || targets[0];
          const wsUrl = nodeTarget.webSocketDebuggerUrl;
          if (!wsUrl) {
            reject(
              new Error(
                `Target found but no webSocketDebuggerUrl: ${JSON.stringify(nodeTarget)}`,
              ),
            );
            return;
          }
          resolve({ wsUrl, title: nodeTarget.title, id: nodeTarget.id });
        } catch (e) {
          reject(new Error(`Failed to parse /json response: ${e.message}`));
        }
      });
    });
    req.on("error", (e) => {
      reject(
        new Error(
          `Cannot connect to http://127.0.0.1:${port}/json — ` +
            `is VS Code running with --inspect-extensions=${port}?\n` +
            `  Error: ${e.message}`,
        ),
      );
    });
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error(`Timeout connecting to port ${port}`));
    });
  });
}

// ---------------------------------------------------------------------------
// CDP 通信
// ---------------------------------------------------------------------------

let msgId = 0;
const pending = new Map();

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(
      () => reject(new Error("WebSocket connection timeout")),
      CONNECT_TIMEOUT,
    );
  });
}

function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }
    }, CONNECT_TIMEOUT);
  });
}

function setupMessageHandler(ws) {
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });
}

async function evaluate(ws, expression) {
  const result = await send(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.result?.exceptionDetails) {
    console.error(
      "Exception:",
      JSON.stringify(result.result.exceptionDetails, null, 2),
    );
    return null;
  }
  return result.result?.result?.value;
}

// ---------------------------------------------------------------------------
// 拦截器安装
// ---------------------------------------------------------------------------

const INTERCEPTOR_CODE = `
(function() {
  if (globalThis.__fetchPatched) {
    return JSON.stringify({ status: "already_patched", captured: globalThis.__capturedRequests?.length || 0 });
  }

  globalThis.__capturedRequests = [];

  // Patch fetch
  const origFetch = globalThis.__vscodeOriginalFetch || globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
    const isTarget = url.includes('snap-access') || url.includes('myhuaweicloud');

    if (isTarget) {
      let bodyStr = '';
      if (init?.body) {
        try {
          bodyStr = typeof init.body === 'string' ? init.body :
                    (init.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) :
                    (init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) :
                    String(init.body)));
        } catch(e) { bodyStr = '[could not read body]'; }
      }

      const headers = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => { headers[k] = v; });
        } else if (typeof init.headers === 'object') {
          Object.assign(headers, init.headers);
        }
      }

      globalThis.__capturedRequests.push({
        timestamp: new Date().toISOString(),
        url: url,
        method: init?.method || 'GET',
        headers: headers,
        body: bodyStr,
        source: 'fetch',
      });
    }

    return origFetch.call(this, input, init);
  };

  // Also patch __vscodePatchedFetch if it exists
  if (globalThis.__vscodePatchedFetch) {
    const origPatched = globalThis.__vscodePatchedFetch;
    globalThis.__vscodePatchedFetch = async function(input, init) {
      const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
      const isTarget = url.includes('snap-access') || url.includes('myhuaweicloud');

      if (isTarget) {
        let bodyStr = '';
        if (init?.body) {
          try {
            bodyStr = typeof init.body === 'string' ? init.body :
                      (init.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) :
                      (init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) :
                      String(init.body)));
          } catch(e) { bodyStr = '[could not read body]'; }
        }

        const headers = {};
        if (init?.headers) {
          if (init.headers instanceof Headers) {
            init.headers.forEach((v, k) => { headers[k] = v; });
          } else if (typeof init.headers === 'object') {
            Object.assign(headers, init.headers);
          }
        }

        globalThis.__capturedRequests.push({
          timestamp: new Date().toISOString(),
          url: url,
          method: init?.method || 'GET',
          headers: headers,
          body: bodyStr,
          source: 'vscodePatchedFetch',
        });
      }

      return origPatched.call(this, input, init);
    };
  }

  // Also try to patch https.request via process.getBuiltinModule
  let httpsPatched = false;
  try {
    const https = process.getBuiltinModule('https');
    const http = process.getBuiltinModule('http');

    function patchModule(mod, protocol) {
      if (!mod || !mod.request) return false;
      const origRequest = mod.request;
      mod.request = function(...args) {
        let options = args[0];
        if (typeof options === 'string') options = new URL(options);
        if (options instanceof URL) {
          options = { hostname: options.hostname, path: options.pathname + options.search, port: options.port };
        }

        const host = options?.hostname || options?.host || '';
        const isTarget = host.includes('snap-access') || host.includes('myhuaweicloud');

        const req = origRequest.apply(this, args);

        if (isTarget) {
          const entry = {
            timestamp: new Date().toISOString(),
            url: protocol + '://' + host + (options?.path || '/'),
            method: options?.method || 'GET',
            headers: { ...options?.headers },
            bodyChunks: [],
            source: protocol + '.request',
          };
          globalThis.__capturedRequests.push(entry);

          const origWrite = req.write.bind(req);
          req.write = function(data, encoding, cb) {
            if (data) {
              try { entry.bodyChunks.push(typeof data === 'string' ? data : data.toString('utf8')); }
              catch(e) { entry.bodyChunks.push('[binary]'); }
            }
            return origWrite(data, encoding, cb);
          };

          const origEnd = req.end.bind(req);
          req.end = function(data, encoding, cb) {
            if (data) {
              try { entry.bodyChunks.push(typeof data === 'string' ? data : data.toString('utf8')); }
              catch(e) { entry.bodyChunks.push('[binary]'); }
            }
            entry.body = entry.bodyChunks.join('');
            return origEnd(data, encoding, cb);
          };
        }

        return req;
      };
      return true;
    }

    httpsPatched = patchModule(https, 'https') && patchModule(http, 'http');
  } catch(e) {
    // getBuiltinModule might not work for http/https
  }

  globalThis.__fetchPatched = true;
  return JSON.stringify({ status: "installed", fetchPatched: true, httpsPatched, captured: 0 });
})()
`;

// ---------------------------------------------------------------------------
// 请求打印与保存
// ---------------------------------------------------------------------------

function ensureOutputDir() {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

let requestCounter = 0;

async function fetchAndPrintRequest(ws, index) {
  const reqData = await evaluate(
    ws,
    `
    (function() {
      const req = globalThis.__capturedRequests[${index}];
      if (!req) return null;
      const body = req.body || (req.bodyChunks ? req.bodyChunks.join('') : '');
      return JSON.stringify({
        timestamp: req.timestamp,
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: body.substring(0, 50000),
        bodyLength: body.length,
        source: req.source || 'unknown',
      }, null, 2);
    })()
  `,
  );

  if (!reqData) return;

  const parsed = JSON.parse(reqData);
  requestCounter++;

  console.log(`\n${"=".repeat(80)}`);
  console.log(`REQUEST #${requestCounter}: ${parsed.method} ${parsed.url}`);
  console.log(`Timestamp: ${parsed.timestamp}`);
  console.log(`Source: ${parsed.source}`);
  console.log(`${"=".repeat(80)}`);
  console.log("\nHEADERS:");
  for (const [k, v] of Object.entries(parsed.headers)) {
    const display = String(v).length > 120 ? String(v).substring(0, 120) + "..." : v;
    console.log(`  ${k}: ${display}`);
  }
  console.log(`\nBODY (${parsed.bodyLength} bytes):`);

  // Try to parse as JSON for pretty printing
  try {
    const bodyJson = JSON.parse(parsed.body);
    if (bodyJson.task_parameters?.tools) {
      const toolNames = bodyJson.task_parameters.tools.map(
        (t) => t.function?.name || t.name || "unknown",
      );
      console.log(
        `  [tools list has ${bodyJson.task_parameters.tools.length} tools: ${toolNames.join(", ")}]`,
      );
      const displayBody = { ...bodyJson };
      displayBody.task_parameters = { ...bodyJson.task_parameters };
      displayBody.task_parameters.tools = `[${toolNames.length} tools: ${toolNames.join(", ")}]`;
      console.log(JSON.stringify(displayBody, null, 2));
    } else {
      console.log(JSON.stringify(bodyJson, null, 2));
    }
  } catch {
    console.log(parsed.body.substring(0, 5000));
  }

  // Save to file
  ensureOutputDir();
  const savePath = join(OUTPUT_DIR, `captured-request-${requestCounter}.json`);
  writeFileSync(savePath, JSON.stringify(parsed, null, 2));
  console.log(`\n  Saved to: ${savePath}`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  let wsUrl;

  if (opts.wsUrl) {
    // 直接传了 ws:// URL
    wsUrl = opts.wsUrl;
    console.log(`Using provided WebSocket URL: ${wsUrl}`);
  } else {
    // 自动检测
    const port = opts.port || DEFAULT_PORT;
    console.log(`Discovering CDP target on port ${port}...`);

    try {
      const target = await discoverWsUrl(port);
      wsUrl = target.wsUrl;
      console.log(`Found target: "${target.title}" (id: ${target.id})`);
      console.log(`WebSocket URL: ${wsUrl}`);
    } catch (e) {
      console.error(`\n${e.message}`);
      console.error(
        `\nMake sure VS Code is running with --inspect-extensions=${port}:`,
      );
      console.error(
        `  codearts-agent --inspect-extensions=${port}`,
      );
      console.error(
        `\nOr set the environment variable:`,
      );
      console.error(
        `  $env:CODEARTS_INSPECT_PORT=${port}`,
      );
      process.exit(1);
    }
  }

  // 连接
  console.log(`\nConnecting to ${wsUrl}...`);
  const ws = await connect(wsUrl);
  setupMessageHandler(ws);
  console.log("Connected!");

  // 安装拦截器
  console.log("\nInstalling request interceptors...");
  const result = await evaluate(ws, INTERCEPTOR_CODE);
  console.log("Interceptor result:", result);

  if (result?.includes?.('"already_patched"')) {
    console.log(
      "\nNote: Interceptors already installed from a previous run.",
    );
    console.log("      Existing captured requests will also be shown.");
  }

  // 等待用户触发请求
  console.log("\n" + "─".repeat(60));
  console.log("  >>> NOW trigger a request in the IDE <<<");
  console.log("  (e.g., send a chat, open a file, etc.)");
  console.log("─".repeat(60));
  console.log(`Polling every ${POLL_INTERVAL / 1000}s (max ${MAX_POLL_ROUNDS * POLL_INTERVAL / 1000}s)...\n`);

  let prevCount = 0;
  for (let i = 0; i < MAX_POLL_ROUNDS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));

    const countStr = await evaluate(
      ws,
      `JSON.stringify({ count: globalThis.__capturedRequests?.length || 0 })`,
    );
    const { count } = JSON.parse(countStr || '{"count":0}');

    if (count > prevCount) {
      console.log(
        `Found ${count} captured request(s) (${count - prevCount} new)! Fetching details...`,
      );

      for (let j = prevCount; j < count; j++) {
        await fetchAndPrintRequest(ws, j);
      }

      prevCount = count;
      console.log("\nWaiting for more requests... (Ctrl+C to stop)");
    } else {
      process.stdout.write(".");
    }
  }

  console.log("\n\nTimeout reached. Closing connection.");
  ws.close();
}

main().catch((e) => {
  console.error("Fatal:", e.message || e);
  process.exit(1);
});
