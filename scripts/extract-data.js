// Extract and analyze CodeArts Agent stored data
// 1. Read full codearts-snap userInfo
// 2. Decrypt HuaweiCloudSession using DPAPI
const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const BASE = "C:/Users/xLight/AppData/Roaming/codearts-agent";

async function main() {
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(
    path.join(BASE, "User/globalStorage/state.vscdb"),
  );
  const db = new SQL.Database(buf);

  // 1. Read full codearts-snap data
  console.log("=== codearts-snap full data ===");
  const snapResult = db.exec(
    "SELECT value FROM ItemTable WHERE key = 'huaweicloud.codearts-snap'",
  );
  if (snapResult.length > 0) {
    const snapData = JSON.parse(snapResult[0].values[0][0]);

    // Print all top-level keys
    console.log("Top-level keys:", Object.keys(snapData));

    // Print userInfoKey details
    if (snapData.userInfoKey) {
      console.log("\nuserInfoKey keys:", Object.keys(snapData.userInfoKey));
      // Print full userInfoKey but redact very long values
      const userInfo = snapData.userInfoKey;
      for (const [k, v] of Object.entries(userInfo)) {
        const val = JSON.stringify(v);
        if (val.length > 300) {
          console.log(
            `  ${k}: (${val.length} chars) ${val.substring(0, 300)}...`,
          );
        } else {
          console.log(`  ${k}: ${val}`);
        }
      }
    }

    // Check for any cloudDragonToken or token-related fields
    const fullStr = JSON.stringify(snapData);
    console.log("\nFull data length:", fullStr.length);

    const patterns = [
      "cloudDragonToken",
      "CloudDragonToken",
      "businessToken",
      "authToken",
      "x-auth-token",
      "accessKey",
      "securityToken",
    ];
    for (const p of patterns) {
      const idx = fullStr.indexOf(p);
      if (idx !== -1) {
        console.log(`\nFOUND "${p}" at offset ${idx}:`);
        console.log(
          "  Context:",
          fullStr.substring(
            Math.max(0, idx - 50),
            Math.min(fullStr.length, idx + 200),
          ),
        );
      }
    }

    // Also dump any keys that look token/auth related
    console.log("\nAll keys that might relate to auth:");
    function findKeys(obj, prefix = "") {
      if (!obj || typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${k}` : k;
        const interesting = [
          "token",
          "auth",
          "secret",
          "key",
          "credential",
          "session",
          "dragon",
          "login",
          "aksk",
          "ak",
          "sk",
        ];
        if (interesting.some((p) => k.toLowerCase().includes(p))) {
          const val = JSON.stringify(v);
          console.log(
            `  ${fullKey}: ${val.substring(0, 200)}${val.length > 200 ? "..." : ""}`,
          );
        }
        if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          findKeys(v, fullKey);
        }
      }
    }
    findKeys(snapData);
  }

  // 2. Read encrypted HuaweiCloudSession
  console.log("\n\n=== HuaweiCloudSession (encrypted) ===");
  const secretResult = db.exec(
    `SELECT value FROM ItemTable WHERE key = 'secret://{"extensionId":"huaweicloud.authentication","key":"HuaweiCloudSession"}'`,
  );
  if (secretResult.length > 0) {
    const secretData = JSON.parse(secretResult[0].values[0][0]);
    console.log("Type:", secretData.type);
    console.log("Data length:", secretData.data.length);
    console.log("First 20 bytes:", secretData.data.slice(0, 20));
    console.log(
      "As string (first 10):",
      Buffer.from(secretData.data.slice(0, 10)).toString(),
    );

    // Save the encrypted data for DPAPI decryption
    const encryptedBuffer = Buffer.from(secretData.data);
    fs.writeFileSync("scripts/encrypted-session.bin", encryptedBuffer);
    console.log("Saved encrypted data to scripts/encrypted-session.bin");
    console.log("Encrypted buffer length:", encryptedBuffer.length);
  }

  // 3. Also check for any other secret:// keys
  console.log("\n\n=== All secret:// keys ===");
  const allSecrets = db.exec(
    "SELECT key FROM ItemTable WHERE key LIKE 'secret://%'",
  );
  if (allSecrets.length > 0) {
    for (const row of allSecrets[0].values) {
      console.log(" ", row[0]);
    }
  }

  db.close();
}

main().catch((e) => console.error("Fatal:", e));
