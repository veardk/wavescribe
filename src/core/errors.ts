// One error type for the whole tool: a stable code, a message, and an actionable hint.

export type ErrorCode =
  | "BAD_INPUT"
  | "UNSUPPORTED_SOURCE"
  | "NOT_FOUND"
  | "NO_TEXT"
  | "NO_PROVIDER"
  | "AUTH"
  | "RATE_LIMIT"
  | "INPUT_TOO_LARGE"
  | "UNSUPPORTED_FORMAT"
  | "TIMEOUT"
  | "EXPIRED"
  | "PROVIDER_ERROR"
  | "NETWORK"
  | "DEPENDENCY"
  | "LOGIN_REQUIRED"
  | "INTERNAL";

export class WsError extends Error {
  code: ErrorCode;
  hint?: string;
  retryable: boolean;
  status?: number;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { hint?: string; retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "WsError";
    this.code = code;
    this.hint = opts.hint;
    this.retryable = opts.retryable ?? (code === "RATE_LIMIT" || code === "NETWORK");
    this.status = opts.status;
  }
}

export function asWsError(err: unknown): WsError {
  if (err instanceof WsError) return err;
  if (err instanceof Error) return new WsError("INTERNAL", err.message, { cause: err });
  return new WsError("INTERNAL", String(err));
}

/** Map an HTTP status to an error code (providers may refine with their own body codes). */
export function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status === 413) return "INPUT_TOO_LARGE";
  if (status === 415) return "UNSUPPORTED_FORMAT";
  if (status === 404) return "NOT_FOUND";
  if (status === 408 || status === 504) return "TIMEOUT";
  return "PROVIDER_ERROR";
}
