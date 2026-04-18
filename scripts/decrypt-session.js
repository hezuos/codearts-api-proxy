// Decrypt CodeArts Agent secrets (same pattern as Chrome/Edge on Windows)
// 1. Decrypt AES key from DPAPI via PowerShell
// 2. Use AES-256-GCM to decrypt the actual secret
const fs = require("fs");
const crypto = require("crypto");
const { execSync } = require("child_process");

async function main() {
  // Step 1: Get the DPAPI-encrypted AES key from Local State
  const localState = JSON.parse(
    fs.readFileSync(
      "C:/Users/xLight/AppData/Roaming/codearts-agent/Local State",
      "utf8",
    ),
  );
  const encryptedKeyB64 = localState.os_crypt.encrypted_key;
  const encryptedKeyBuf = Buffer.from(encryptedKeyB64, "base64");

  // Remove "DPAPI" prefix (5 bytes)
  const prefix = encryptedKeyBuf.slice(0, 5).toString("ascii");
  console.log("Key prefix:", prefix);
  if (prefix !== "DPAPI") {
    throw new Error("Expected DPAPI prefix");
  }
  const dpapiBlob = encryptedKeyBuf.slice(5);
  console.log("DPAPI blob length:", dpapiBlob.length);

  // Step 2: Decrypt AES key using DPAPI via PowerShell
  const dpapiB64 = dpapiBlob.toString("base64");
  const psScript = `
    Add-Type -AssemblyName System.Security
    $encrypted = [Convert]::FromBase64String('${dpapiB64}')
    $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Convert]::ToBase64String($decrypted)
  `;

  const aesKeyB64 = execSync(
    `powershell -NoProfile -Command "${psScript.replace(/\n/g, " ")}"`,
    { encoding: "utf8" },
  ).trim();
  const aesKey = Buffer.from(aesKeyB64, "base64");
  console.log("AES key length:", aesKey.length, "bytes");

  // Step 3: Read the encrypted secret
  const encryptedData = fs.readFileSync("scripts/encrypted-session.bin");
  console.log("Encrypted data length:", encryptedData.length);
  console.log(
    "Encrypted data prefix:",
    encryptedData.slice(0, 3).toString("ascii"),
  );

  // Step 4: Decrypt using AES-256-GCM
  // Format: "v10" (3 bytes) + nonce (12 bytes) + ciphertext + auth_tag (16 bytes)
  const versionPrefix = encryptedData.slice(0, 3).toString("ascii");
  if (versionPrefix !== "v10") {
    throw new Error("Expected v10 prefix, got: " + versionPrefix);
  }

  const nonce = encryptedData.slice(3, 3 + 12);
  const ciphertextWithTag = encryptedData.slice(3 + 12);
  const authTag = ciphertextWithTag.slice(ciphertextWithTag.length - 16);
  const ciphertext = ciphertextWithTag.slice(0, ciphertextWithTag.length - 16);

  console.log("Nonce length:", nonce.length);
  console.log("Ciphertext length:", ciphertext.length);
  console.log("Auth tag length:", authTag.length);

  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  const decryptedStr = decrypted.toString("utf8");
  console.log("\n=== Decrypted HuaweiCloudSession ===");
  console.log("Length:", decryptedStr.length);

  // Try to parse as JSON
  try {
    const session = JSON.parse(decryptedStr);
    console.log("Keys:", Object.keys(session));

    // Print each field (redact long values)
    for (const [k, v] of Object.entries(session)) {
      const val = JSON.stringify(v);
      if (val && val.length > 100) {
        console.log(
          `  ${k}: (${val.length} chars) ${val.substring(0, 100)}...`,
        );
      } else {
        console.log(`  ${k}: ${val}`);
      }
    }

    // Check for cloudDragonToken specifically
    if (session.cloudDragonToken) {
      console.log("\n*** FOUND cloudDragonToken! ***");
      console.log("Length:", session.cloudDragonToken.length);
      console.log("First 50 chars:", session.cloudDragonToken.substring(0, 50));
    }
  } catch (e) {
    console.log("Not JSON, raw content:");
    console.log(decryptedStr.substring(0, 500));
  }
}

main().catch((e) => console.error("Error:", e));
