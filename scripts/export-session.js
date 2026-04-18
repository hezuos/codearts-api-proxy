// export-session.js — Decrypt and export session to JSON file
// Uses pre-saved AES key from scripts/aes-key.bin (already DPAPI-decrypted)
// Usage: node scripts/export-session.js [output-path]
const fs = require("fs");
const crypto = require("crypto");

async function main() {
  const outPath = process.argv[2] || "scripts/session-decrypted.json";

  // Read the pre-decrypted AES-256 key
  const aesKey = fs.readFileSync("scripts/aes-key.bin");
  if (aesKey.length !== 32) {
    throw new Error(`Expected 32-byte AES key, got ${aesKey.length}`);
  }

  // Read and decrypt session
  const encryptedData = fs.readFileSync("scripts/encrypted-session.bin");
  if (encryptedData.slice(0, 3).toString("ascii") !== "v10") {
    throw new Error("Expected v10 prefix");
  }
  const nonce = encryptedData.slice(3, 15);
  const ciphertextWithTag = encryptedData.slice(15);
  const authTag = ciphertextWithTag.slice(ciphertextWithTag.length - 16);
  const ciphertext = ciphertextWithTag.slice(0, ciphertextWithTag.length - 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  const session = JSON.parse(decrypted.toString("utf8"));

  // Write to file
  fs.writeFileSync(outPath, JSON.stringify(session, null, 2));
  console.log(`Session exported to: ${outPath}`);
  console.log(`  accessKey: ${session.accessKey}`);
  console.log(`  secretKey: ${session.secretKey?.substring(0, 4)}****`);
  console.log(
    `  securitytoken: ${session.securitytoken ? "(present, " + session.securitytoken.length + " chars)" : "(none)"}`,
  );
  console.log(`  expires_at: ${session.expires_at}`);
}

main().catch((e) => console.error("Error:", e));
