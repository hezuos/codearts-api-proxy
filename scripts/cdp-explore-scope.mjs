#!/usr/bin/env node
/**
 * Quick CDP scope exploration
 */
import WebSocket from "ws";

const WS_URL = "ws://127.0.0.1:63732/808c4f8b-076d-4c27-96c9-e70180b4c4a2";

const ws = new WebSocket(WS_URL);
let id = 0;

function send(method, params) {
  const myId = ++id;
  return new Promise((resolve) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === myId) {
        ws.removeListener("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
}

async function evalExpr(expr) {
  const res = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.result?.exceptionDetails) {
    return {
      error:
        res.result.exceptionDetails.exception?.description ||
        res.result.exceptionDetails.text,
    };
  }
  return res.result?.result?.value;
}

ws.on("open", async () => {
  console.log("Connected!\n");

  // 1. Check what's in global scope
  console.log("=== Global Scope ===");
  const scope = await evalExpr(`JSON.stringify({
    hasRequire: typeof require,
    hasProcess: typeof process,
    hasModule: typeof module,
    processType: typeof process !== 'undefined' ? process.type : null,
    processTitle: typeof process !== 'undefined' ? process.title : null,
    globalKeys: Object.keys(globalThis).filter(k => !k.startsWith('_')).slice(0, 50),
  })`);
  console.log(scope);

  // 2. Try to access Node.js builtins
  console.log("\n=== Node.js Builtins ===");
  const builtins = await evalExpr(`JSON.stringify({
    hasCreateRequire: typeof process?.mainModule !== 'undefined',
    processMainModule: typeof process?.mainModule,
    hasNodeModule: typeof globalThis.module,
    hasBuffer: typeof Buffer,
    hasImport: typeof import,
  })`);
  console.log(builtins);

  // 3. Try process.mainModule.require
  console.log("\n=== Try Alternate Require ===");
  const altReq = await evalExpr(`
    (function() {
      try {
        // Try various ways to get require
        if (typeof process !== 'undefined' && process.mainModule && process.mainModule.require) {
          return 'process.mainModule.require available';
        }
        // Try globalThis.__non_webpack_require__
        if (typeof globalThis.__non_webpack_require__ !== 'undefined') {
          return 'globalThis.__non_webpack_require__ available';
        }
        // Check Module
        if (typeof module !== 'undefined' && module.constructor) {
          const Module = module.constructor;
          const m = new Module('');
          m.paths = module.paths;
          return 'Module constructor available: ' + typeof m.require;
        }
        // Try to find require in process.mainModule
        return JSON.stringify({
          processKeys: Object.keys(process).filter(k => k.includes('module') || k.includes('require') || k.includes('Module')),
        });
      } catch(e) {
        return 'Error: ' + e.message;
      }
    })()
  `);
  console.log(altReq);

  // 4. Check if there's anything related to http/https in global
  console.log("\n=== Check for HTTP in globals ===");
  const httpCheck = await evalExpr(`
    (function() {
      const results = [];
      for (const key of Object.getOwnPropertyNames(globalThis)) {
        try {
          const val = globalThis[key];
          const str = String(val).substring(0, 100);
          if (str.includes('http') || str.includes('request') || str.includes('fetch') || 
              key.toLowerCase().includes('http') || key.toLowerCase().includes('fetch')) {
            results.push(key + ': ' + typeof val);
          }
        } catch(e) {}
      }
      return JSON.stringify(results);
    })()
  `);
  console.log(httpCheck);

  ws.close();
  process.exit(0);
});

setTimeout(() => process.exit(1), 15000);
