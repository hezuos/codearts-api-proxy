// CDP probe script - connects to CodeArts Agent extension host via Chrome DevTools Protocol
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

async function evaluate(ws, expression, opts = {}) {
  const result = await send(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    ...opts,
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

  // 1. Basic process info
  console.log("=== Process Info ===");
  const procInfo = await evaluate(
    ws,
    `JSON.stringify({
    title: process.title,
    pid: process.pid,
    argv: process.argv.slice(0, 5),
    cwd: process.cwd(),
    env_VSCODE_PID: process.env.VSCODE_PID,
  })`,
  );
  console.log(procInfo, "\n");

  // 2. Check what globals/modules are available
  console.log("=== Available Globals ===");
  const globals = await evaluate(
    ws,
    `JSON.stringify({
    hasRequire: typeof require !== 'undefined',
    hasModule: typeof module !== 'undefined',
    hasGlobal: typeof global !== 'undefined',
    globalKeys: Object.keys(global).filter(k => !k.startsWith('_')).slice(0, 30),
  })`,
  );
  console.log(globals, "\n");

  // 3. Try to find the vscode module / extension host API
  console.log("=== VS Code API Access ===");
  const vsCodeAccess = await evaluate(
    ws,
    `
    (function() {
      try {
        // Try to find vscode module in require cache
        const keys = Object.keys(require.cache || {});
        const vsCodeKeys = keys.filter(k => k.includes('extHost') || k.includes('vscode') || k.includes('extensionHostProcess'));
        return JSON.stringify({
          totalModules: keys.length,
          relevantModules: vsCodeKeys.slice(0, 20),
        });
      } catch(e) {
        return JSON.stringify({ error: e.message });
      }
    })()
  `,
  );
  console.log(vsCodeAccess, "\n");

  // 4. Try to access the extension host internals
  console.log("=== Extension Host Internals ===");
  const extHostInfo = await evaluate(
    ws,
    `
    (function() {
      try {
        const keys = Object.keys(require.cache || {});
        // Look for authentication related modules
        const authKeys = keys.filter(k => 
          k.includes('authentication') || 
          k.includes('credential') || 
          k.includes('secret') ||
          k.includes('token')
        );
        return JSON.stringify({
          authModules: authKeys.slice(0, 15),
        });
      } catch(e) {
        return JSON.stringify({ error: e.message });
      }
    })()
  `,
  );
  console.log(extHostInfo, "\n");

  // 5. Try to find and call vscode commands
  console.log("=== Try executeCommand ===");
  const cmdResult = await evaluate(
    ws,
    `
    (async function() {
      try {
        // Try to find the command service or vscode API
        const keys = Object.keys(require.cache || {});
        
        // Look for extHostCommands or similar
        const cmdKeys = keys.filter(k => k.includes('extHostCommand') || k.includes('extHostApi'));
        
        // Also try to find the actual vscode module
        let vsCodeApi = null;
        for (const key of keys) {
          const mod = require.cache[key];
          if (mod && mod.exports && mod.exports.commands && mod.exports.commands.executeCommand) {
            vsCodeApi = mod.exports;
            break;
          }
        }
        
        if (vsCodeApi) {
          // Try to get user info
          const userInfo = await vsCodeApi.commands.executeCommand('vscode.getUserInfo');
          return JSON.stringify({
            found: true,
            userInfoKeys: userInfo ? Object.keys(userInfo) : null,
            userInfo: userInfo,
          });
        }
        
        return JSON.stringify({
          found: false,
          cmdModules: cmdKeys.slice(0, 10),
        });
      } catch(e) {
        return JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500) });
      }
    })()
  `,
  );
  console.log(cmdResult, "\n");

  // 6. Try to find authentication sessions
  console.log("=== Authentication Sessions ===");
  const authResult = await evaluate(
    ws,
    `
    (async function() {
      try {
        const keys = Object.keys(require.cache || {});
        let vsCodeApi = null;
        for (const key of keys) {
          const mod = require.cache[key];
          if (mod && mod.exports && mod.exports.authentication) {
            vsCodeApi = mod.exports;
            break;
          }
        }
        
        if (vsCodeApi && vsCodeApi.authentication) {
          // Try to get sessions
          const sessions1 = await vsCodeApi.authentication.getSession('huawei-cloud-authentication', [''], { silent: true });
          const sessions2 = await vsCodeApi.authentication.getSession('huawei-authentication', [''], { silent: true });
          return JSON.stringify({
            found: true,
            hcSession: sessions1 ? { id: sessions1.id, scopes: sessions1.scopes, keys: Object.keys(sessions1) } : null,
            hwSession: sessions2 ? { id: sessions2.id, scopes: sessions2.scopes, keys: Object.keys(sessions2) } : null,
          });
        }
        
        return JSON.stringify({ found: false });
      } catch(e) {
        return JSON.stringify({ error: e.message });
      }
    })()
  `,
  );
  console.log(authResult, "\n");

  // 7. Deep scan - look for any object with cloudDragonToken
  console.log("=== Deep Scan for cloudDragonToken ===");
  const deepScan = await evaluate(
    ws,
    `
    (function() {
      try {
        const keys = Object.keys(require.cache || {});
        const results = [];
        
        for (const key of keys) {
          try {
            const mod = require.cache[key];
            if (!mod || !mod.exports) continue;
            const exports = mod.exports;
            
            // Check if the module exports contain cloudDragonToken
            const str = JSON.stringify(exports).slice(0, 5000);
            if (str.includes('cloudDragonToken') || str.includes('CloudDragonToken')) {
              results.push({
                module: key.split(/[\\/]/).slice(-3).join('/'),
                preview: str.slice(0, 200),
              });
            }
          } catch(e) {
            // skip modules that can't be stringified
          }
        }
        
        return JSON.stringify({ count: results.length, results: results.slice(0, 10) });
      } catch(e) {
        return JSON.stringify({ error: e.message });
      }
    })()
  `,
  );
  console.log(deepScan, "\n");

  ws.close();
  console.log("Done.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
