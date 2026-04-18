// Decrypt HuaweiCloudSession using the decrypted AES-256-GCM key
const fs = require("fs");
const crypto = require("crypto");

const aesKey = fs.readFileSync("scripts/aes-key.bin");
console.log("AES key length:", aesKey.length, "bytes");

const encryptedData = fs.readFileSync("scripts/encrypted-session.bin");
console.log("Encrypted data length:", encryptedData.length);

// Format: "v10" (3 bytes) + nonce (12 bytes) + ciphertext + auth_tag (16 bytes)
const versionPrefix = encryptedData.slice(0, 3).toString("ascii");
console.log("Version prefix:", versionPrefix);

const nonce = encryptedData.slice(3, 3 + 12);
const ciphertextWithTag = encryptedData.slice(3 + 12);
const authTag = ciphertextWithTag.slice(ciphertextWithTag.length - 16);
const ciphertext = ciphertextWithTag.slice(0, ciphertextWithTag.length - 16);

console.log("Nonce:", nonce.toString("hex"));
console.log("Ciphertext length:", ciphertext.length);
console.log("Auth tag:", authTag.toString("hex"));

const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
decipher.setAuthTag(authTag);

let decrypted = decipher.update(ciphertext);
decrypted = Buffer.concat([decrypted, decipher.final()]);

const decryptedStr = decrypted.toString("utf8");
console.log("\n=== Decrypted HuaweiCloudSession ===");
console.log("Length:", decryptedStr.length);

try {
  const session = JSON.parse(decryptedStr);
  console.log("\nKeys:", Object.keys(session));

  for (const [k, v] of Object.entries(session)) {
    const val = typeof v === "string" ? v : JSON.stringify(v);
    if (val && val.length > 150) {
      console.log(`\n  ${k}: (${val.length} chars)`);
      console.log(`    ${val.substring(0, 150)}...`);
    } else {
      console.log(`\n  ${k}: ${val}`);
    }
  }

  // Specifically check for cloudDragonToken
  const fullStr = JSON.stringify(session);
  const patterns = [
    "cloudDragonToken",
    "CloudDragonToken",
    "businessToken",
    "authToken",
  ];
  for (const p of patterns) {
    if (fullStr.includes(p)) {
      console.log(`\n*** FOUND: "${p}" in session! ***`);
    }
  }
} catch (e) {
  console.log("Not valid JSON. Raw content:");
  console.log(decryptedStr);
}
