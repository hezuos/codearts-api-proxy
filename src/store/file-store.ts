import fs from "fs";
import path from "path";
import { config } from "../config";
import { decryptString, encryptString } from "../auth/crypto/encryption";

/**
 * Read and decrypt a single entity file.
 * Returns parsed JSON object, or null if file doesn't exist.
 */
export function readEncryptedFile<T = unknown>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const decrypted = decryptString(raw);
  return JSON.parse(decrypted) as T;
}

/**
 * Encrypt and write a single entity file.
 * Creates parent directories if needed.
 * Each write generates a fresh IV (handled by encryptString).
 */
export function writeEncryptedFile(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const serialized = JSON.stringify(data);
  fs.writeFileSync(filePath, encryptString(serialized), "utf8");
}

/**
 * Read a plaintext JSON file (e.g., admin.json).
 * Returns parsed object, or null if file doesn't exist.
 */
export function readPlaintextFile<T = unknown>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

/**
 * Write a plaintext JSON file.
 * Creates parent directories if needed.
 */
export function writePlaintextFile(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Delete a file if it exists.
 */
export function deleteFile(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Recursively delete a directory and all its contents.
 */
export function deleteDir(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

/**
 * Resolve a path relative to the data directory.
 */
export function dataPath(...segments: string[]): string {
  return path.resolve(process.cwd(), config.dataDir, ...segments);
}
