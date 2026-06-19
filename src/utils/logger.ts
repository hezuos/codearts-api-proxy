/**
 * Lightweight structured logger.
 * - Development: human-readable colored output
 * - Production: JSON output for log aggregation
 * - Supports traceId propagation via withTrace()
 * - Supports file output via LOG_FILE env var
 */

import fs from "fs";
import path from "path";

type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const VALID_LEVELS = new Set<string>(Object.keys(LOG_LEVELS));

function resolveLogLevel(): LogLevel {
  const env = process.env.LOG_LEVEL;
  if (env && VALID_LEVELS.has(env)) return env as LogLevel;
  if (env) {
    process.stderr.write(`[logger] Invalid LOG_LEVEL="${env}", valid values: ${Object.keys(LOG_LEVELS).join(", ")}\n`);
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

const currentLevel: LogLevel = resolveLogLevel();
const isJsonOutput = process.env.NODE_ENV === "production";

// ── File output ────────────────────────────────────────────────────────────
const logFile = process.env.LOG_FILE;
let logStream: fs.WriteStream | null = null;
if (logFile) {
  try {
    const dir = path.dirname(logFile);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    logStream = fs.createWriteStream(logFile, { flags: "a" });
    process.stderr.write(`[logger] Logging to file: ${logFile}\n`);
  } catch (e) {
    process.stderr.write(`[logger] Failed to open log file "${logFile}": ${e}\n`);
  }
}

function writeToFile(line: string): void {
  if (logStream) {
    logStream.write(line + "\n");
  }
}

// ── Level filter ───────────────────────────────────────────────────────────
function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

// ── Formatters ─────────────────────────────────────────────────────────────
function formatJson(level: LogLevel, traceId: string | undefined, msg: string, data?: Record<string, unknown>): string {
  const entry: Record<string, unknown> = {
    level,
    timestamp: new Date().toISOString(),
    message: msg,
  };
  if (traceId) entry.traceId = traceId;
  if (data) Object.assign(entry, data);
  return JSON.stringify(entry);
}

function formatReadable(level: LogLevel, traceId: string | undefined, msg: string, data?: Record<string, unknown>): string {
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  const prefix = traceId ? `[${traceId}]` : "";
  const levelTag = level.toUpperCase().padStart(5);
  let line = `${ts} ${levelTag} ${prefix} ${msg}`;
  if (data && Object.keys(data).length > 0) {
    line += " " + JSON.stringify(data);
  }
  return line;
}

export class Logger {
  private readonly _traceId: string | undefined;

  constructor(traceId?: string) {
    this._traceId = traceId;
  }

  /** Create a child logger that carries a traceId. */
  withTrace(traceId: string): Logger {
    return new Logger(traceId);
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    if (!shouldLog("debug")) return;
    this._emit("debug", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    if (!shouldLog("info")) return;
    this._emit("info", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    if (!shouldLog("warn")) return;
    this._emit("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    if (!shouldLog("error")) return;
    this._emit("error", msg, data);
  }

  private _emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    const formatted = isJsonOutput
      ? formatJson(level, this._traceId, msg, data)
      : formatReadable(level, this._traceId, msg, data);

    // Console output
    switch (level) {
      case "error":
        process.stderr.write(formatted + "\n");
        break;
      default:
        process.stdout.write(formatted + "\n");
        break;
    }

    // File output
    writeToFile(formatted);
  }
}

/** Root logger without trace context. */
export const logger = new Logger();

/** Flush and close the log file (call on shutdown). */
export function closeLogger(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}
