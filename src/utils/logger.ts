/**
 * Lightweight structured logger.
 * - Development: human-readable colored output
 * - Production: JSON output for log aggregation
 * - Supports traceId propagation via withTrace()
 */

type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) ??
  (process.env.NODE_ENV === "production" ? "info" : "debug");

const isJsonOutput = process.env.NODE_ENV === "production";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

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

    switch (level) {
      case "error":
        process.stderr.write(formatted + "\n");
        break;
      default:
        process.stdout.write(formatted + "\n");
        break;
    }
  }
}

/** Root logger without trace context. */
export const logger = new Logger();
