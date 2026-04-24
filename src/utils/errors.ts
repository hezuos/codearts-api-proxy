/**
 * Structured error classification for the proxy.
 * Each error class carries a traceId for log correlation.
 */

export class AppError extends Error {
  public readonly traceId?: string;

  constructor(message: string, traceId?: string) {
    super(message);
    this.name = "AppError";
    this.traceId = traceId;
  }
}

export class UpstreamAuthError extends AppError {
  public readonly httpStatus: number;
  public readonly responseBody: string;

  constructor(httpStatus: number, responseBody: string, traceId?: string) {
    super(
      `CodeArts auth error (HTTP ${httpStatus}): ${responseBody.substring(0, 300)}`,
      traceId,
    );
    this.name = "UpstreamAuthError";
    this.httpStatus = httpStatus;
    this.responseBody = responseBody;
  }
}

export class UpstreamServerError extends AppError {
  public readonly httpStatus: number;
  public readonly responseBody: string;

  constructor(httpStatus: number, responseBody: string, traceId?: string) {
    super(
      `CodeArts server error (HTTP ${httpStatus}): ${responseBody.substring(0, 300)}`,
      traceId,
    );
    this.name = "UpstreamServerError";
    this.httpStatus = httpStatus;
    this.responseBody = responseBody;
  }
}

export class UpstreamTimeoutError extends AppError {
  public readonly url: string;
  public readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number, traceId?: string) {
    super(`Upstream request timeout: ${url} (${timeoutMs}ms)`, traceId);
    this.name = "UpstreamTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export class ProtocolError extends AppError {
  public readonly rawData?: string;

  constructor(message: string, rawData?: string, traceId?: string) {
    super(message, traceId);
    this.name = "ProtocolError";
    this.rawData = rawData;
  }
}
