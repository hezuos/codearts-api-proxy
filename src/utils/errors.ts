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

export class UpstreamConcurrencyError extends AppError {
  public readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs = 0, traceId?: string) {
    super(message, traceId);
    this.name = "UpstreamConcurrencyError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * 上游因 prompt/上下文长度超限拒绝请求（HTTP 413 或 ChatAgent.00001216）。
 * 代理不再改写历史，直接把这一语义透传给客户端，由其决定压缩或摘要。
 */
export class UpstreamContextLengthError extends AppError {
  public readonly responseBody: string;

  constructor(responseBody: string, traceId?: string) {
    super(
      `Upstream context length limit exceeded: ${responseBody.substring(0, 300)}`,
      traceId,
    );
    this.name = "UpstreamContextLengthError";
    this.responseBody = responseBody;
  }
}

/** 判断上游错误体是否表示 prompt 长度超限。 */
export function isPromptLengthExceeded(text: string | undefined): boolean {
  if (!text) return false;
  return text.includes("ChatAgent.00001216") || /prompt\s*length/i.test(text);
}

export class ProtocolError extends AppError {
  public readonly rawData?: string;

  constructor(message: string, rawData?: string, traceId?: string) {
    super(message, traceId);
    this.name = "ProtocolError";
    this.rawData = rawData;
  }
}
