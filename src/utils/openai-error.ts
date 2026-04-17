export function createOpenAIError(
  message: string,
  type = "invalid_request_error",
  code: string | null = null,
) {
  return {
    error: {
      message,
      type,
      param: null,
      code,
    },
  };
}
