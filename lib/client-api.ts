export type ApiErrorKind = "unauthorized" | "forbidden" | "http" | "network" | "invalid-response";

export class ApiRequestError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: string;

  constructor(
    message: string,
    options: { kind: ApiErrorKind; status?: number; code?: string },
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
  }
}

const GENERIC_SERVER_ERROR = "The server encountered an error. Please try again later.";
const GENERIC_REQUEST_ERROR = "The request could not be completed. Please try again.";

function isSafeClientErrorText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const message = value.trim();
  if (!message || message.length > 500) return false;

  // API validation messages are useful to users, but never surface diagnostics
  // if a route accidentally serializes an exception in a 4xx response.
  return !/(?:\b(?:PrismaClient|PrismaKnownRequestError|SQLSTATE|ECONN(?:REFUSED|RESET|TIMEDOUT)|stack trace|query engine|database error|internal|debug|diagnostic|upstream|proxy|server error)\b|\bunique constraint\b|\bat\s+\S+.*\(|\/(?:app|home|usr|var)\/|\b(?:password|secret|api[_ -]?key|token)\s*[:=])/i.test(message);
}

function responseErrorMessage(payload: unknown, status: number): { message: string; code?: string } {
  // Do not trust any response body from a 5xx. It may contain a stack trace,
  // database error, infrastructure detail, or other server-only information.
  if (status >= 500) return { message: GENERIC_SERVER_ERROR };

  const body = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const code = isSafeClientErrorText(body.error) ? body.error : undefined;

  if (status === 401) {
    return { message: "Your session has expired or sign-in is required. Please sign in again.", code };
  }
  if (status === 403) {
    const message = isSafeClientErrorText(body.message)
      ? body.message.trim()
      : "You do not have permission to perform this action.";
    return { message, code };
  }

  const message = isSafeClientErrorText(body.message)
    ? body.message.trim()
    : isSafeClientErrorText(body.error)
      ? body.error.trim()
      : `Request failed (${status}).`;
  return { message: message || GENERIC_REQUEST_ERROR, code };
}

/** Parse the JSON response contract used by the app's API routes. */
export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    throw new ApiRequestError("Unable to reach the server. Check your connection and try again.", {
      kind: "network",
    });
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Error responses can be non-JSON (for example, a reverse-proxy failure).
  }

  if (!response.ok) {
    const { message, code } = responseErrorMessage(payload, response.status);
    throw new ApiRequestError(message, {
      kind: response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : "http",
      status: response.status,
      code,
    });
  }

  if (payload === null) {
    throw new ApiRequestError("The server returned an invalid response. Please try again.", {
      kind: "invalid-response",
      status: response.status,
    });
  }

  return payload as T;
}

export function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError || error instanceof Error ? error.message : fallback;
}
