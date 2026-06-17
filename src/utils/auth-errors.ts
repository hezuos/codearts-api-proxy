/**
 * IAM 请求错误类型枚举，对标上游 EXCEPTIONS 枚举。
 * 用于结构化错误分类和恢复策略。
 */
export enum IAMRequestErrorType {
  UNAUTHORIZED = "Authentication Error",
  PROXY = "Proxy Authentication Error",
  FORBIDDEN_TOKEN = "IAM.1201",
  FORBIDDEN_API_ACCESS = "not programmatic access",
  TIMEOUT = "Login Timeout",
  FAILED = "Login Failed",
  USER_CANCELED = "User Canceled",
  SYSTEM_CANCELED = "System Canceled",
  USER_OR_PWD = "Invalid user name or password",
  ACCOUNT_LOCKED = "The account is locked.",
  ACCOUNT_DISABLED = "The account is disabled.",
  EXPIRED_REFRESH_TOKEN = "Expired refresh token",
}

/**
 * HTTP 级错误码枚举，对标上游 EXCEPTIONS_CODE。
 */
export enum IAMHttpErrorCode {
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  PROXY = 407,
  TIMEOUT = 408,
  CODE_ERROR = 460,
  NO_PROXY = 502,
  GATEWAY_TIMEOUT = 504,
}

/**
 * 根据 HTTP 状态码和响应体文本，将错误分类为 IAMRequestErrorType。
 */
export function classifyIAMError(
  statusCode: number,
  bodyText: string,
): IAMRequestErrorType | null {
  if (statusCode === IAMHttpErrorCode.UNAUTHORIZED) {
    return IAMRequestErrorType.UNAUTHORIZED;
  }

  if (statusCode === IAMHttpErrorCode.PROXY) {
    return IAMRequestErrorType.PROXY;
  }

  if (statusCode === IAMHttpErrorCode.TIMEOUT) {
    return IAMRequestErrorType.TIMEOUT;
  }

  if (statusCode === IAMHttpErrorCode.GATEWAY_TIMEOUT) {
    return IAMRequestErrorType.TIMEOUT;
  }

  if (bodyText.includes(IAMRequestErrorType.FORBIDDEN_TOKEN)) {
    return IAMRequestErrorType.FORBIDDEN_TOKEN;
  }

  if (bodyText.includes(IAMRequestErrorType.FORBIDDEN_API_ACCESS)) {
    return IAMRequestErrorType.FORBIDDEN_API_ACCESS;
  }

  if (bodyText.includes(IAMRequestErrorType.ACCOUNT_LOCKED)) {
    return IAMRequestErrorType.ACCOUNT_LOCKED;
  }

  if (bodyText.includes(IAMRequestErrorType.ACCOUNT_DISABLED)) {
    return IAMRequestErrorType.ACCOUNT_DISABLED;
  }

  if (bodyText.includes(IAMRequestErrorType.USER_OR_PWD)) {
    return IAMRequestErrorType.USER_OR_PWD;
  }

  return null;
}
