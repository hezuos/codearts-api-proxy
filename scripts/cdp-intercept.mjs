#!/usr/bin/env node
/**
 * cdp-intercept.mjs — Intercept HTTPS requests from the CodeArts Agent extension host
 *
 * Uses Chrome DevTools Protocol to monkey-patch https.request in the extension host process,
 * capturing the full request (URL, method, headers, body) for snap-access API calls.
 *
 * Usage:
 *   1. Run this script
 *   2. Trigger a chat in the IDE
 *   3. The script will print the captured request
 */
import WebSocket from "ws";

const WS_URL =
  process.argv[2] ||
  "ws://127.0.0.1:63732/808c4f8b-076d-4c27-96c9-e70180b4c4a2";
const TIMEOUT = 15000;

let msgId = 0;
const pending = new Map();

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("Connection timeout")), TIMEOUT);
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
    }, TIMEOUT);
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

async function main() {
  console.log(`Connecting to ${WS_URL}...`);
  const ws = await connect();
  setupMessageHandler(ws);
  console.log("Connected!\n");

  // Step 1: Install the HTTPS request interceptor
  console.log("Installing request interceptors...");

  // Patch fetch (the primary API available in this Electron utility process)
  const installFetch = await evaluate(
    ws,
    `
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
  `,
  );
  console.log("Interceptor result:", installFetch);

  // Step 2: Wait for the user to trigger a chat
  console.log("\n>>> NOW trigger a chat request in the IDE <<<");
  console.log("Polling for captured requests every 2 seconds...\n");

  let prevCount = 0;
  const maxWait = 120; // 120 * 2s = 240s = 4 minutes
  for (let i = 0; i < maxWait; i++) {
    await new Promise((r) => setTimeout(r, 2000));

    const countStr = await evaluate(
      ws,
      `JSON.stringify({ count: globalThis.__capturedRequests?.length || 0 })`,
    );
    const { count } = JSON.parse(countStr || '{"count":0}');

    if (count > prevCount) {
      console.log(`Found ${count} captured request(s)! Fetching details...`);

      // Fetch all new requests
      for (let j = prevCount; j < count; j++) {
        const reqData = await evaluate(
          ws,
          `
          (function() {
            const req = globalThis.__capturedRequests[${j}];
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

        if (reqData) {
          const parsed = JSON.parse(reqData);
          console.log(`\n${"=".repeat(80)}`);
          console.log(`REQUEST #${j + 1}: ${parsed.method} ${parsed.url}`);
          console.log(`Timestamp: ${parsed.timestamp}`);
          console.log(`${"=".repeat(80)}`);
          console.log("\nHEADERS:");
          for (const [k, v] of Object.entries(parsed.headers)) {
            const display =
              String(v).length > 100 ? String(v).substring(0, 100) + "..." : v;
            console.log(`  ${k}: ${display}`);
          }
          console.log(`\nBODY (${parsed.bodyLength} bytes):`);

          // Try to parse as JSON for pretty printing
          try {
            const bodyJson = JSON.parse(parsed.body);
            // For chat requests, truncate tools list for readability
            if (bodyJson.task_parameters?.tools) {
              const toolNames = bodyJson.task_parameters.tools.map(
                (t) => t.function?.name || t.name || "unknown",
              );
              console.log(
                `  [tools list has ${bodyJson.task_parameters.tools.length} tools: ${toolNames.join(", ")}]`,
              );
              // Replace tools with summary for display
              const displayBody = { ...bodyJson };
              displayBody.task_parameters = { ...bodyJson.task_parameters };
              displayBody.task_parameters.tools = `[${toolNames.length} tools: ${toolNames.join(", ")}]`;
              console.log(JSON.stringify(displayBody, null, 2));

              // Also save the full body to a file
              const fs = await import("fs");
              const savePath = `scripts/captured-request-${j + 1}.json`;
              fs.writeFileSync(savePath, JSON.stringify(parsed, null, 2));
              console.log(`\n  Full request saved to: ${savePath}`);
            } else {
              console.log(JSON.stringify(bodyJson, null, 2));
            }
          } catch {
            console.log(parsed.body.substring(0, 5000));
          }
        }
      }

      prevCount = count;
      console.log("\nWaiting for more requests... (Ctrl+C to stop)");
    } else {
      process.stdout.write(".");
    }
  }

  console.log("\nTimeout reached. Closing connection.");
  ws.close();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
