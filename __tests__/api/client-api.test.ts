import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, apiErrorMessage, requestJson } from "@/lib/client-api";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

function expectApiRequestError(error: unknown): asserts error is ApiRequestError {
  expect(error).toBeInstanceOf(ApiRequestError);
  if (!(error instanceof ApiRequestError)) {
    throw new Error("Expected requestJson to reject with ApiRequestError.");
  }
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("requestJson error handling", () => {
  it("uses the typed unauthorized contract for JSON 401 responses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: "UNAUTHENTICATED",
      message: "session diagnostics and private server details",
    }, 401));

    const error = await requestJson("/api/example").catch((caught: unknown) => caught);

    expectApiRequestError(error);
    expect(error).toMatchObject({ kind: "unauthorized", status: 401 });
    expect(error.message).toContain("session has expired");
    expect(error.message).not.toContain("diagnostics");
  });

  it("uses the same typed unauthorized contract for non-JSON 401 responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response("proxy authentication details", { status: 401 }));

    await expect(requestJson("/api/example")).rejects.toMatchObject({
      name: "ApiRequestError",
      kind: "unauthorized",
      status: 401,
      message: expect.stringContaining("session has expired"),
    });
  });

  it.each([
    ["JSON", jsonResponse({ error: "FORBIDDEN", message: "internal permission diagnostic" }, 403)],
    ["non-JSON", new Response("internal permission diagnostic", { status: 403 })],
  ])("uses the typed forbidden contract for %s 403 responses", async (_format, response) => {
    fetchMock.mockResolvedValueOnce(response);

    const error = await requestJson("/api/example").catch((caught: unknown) => caught);

    expectApiRequestError(error);
    expect(error).toMatchObject({ kind: "forbidden", status: 403 });
    expect(error.message).toBe("You do not have permission to perform this action.");
    expect(error.message).not.toContain("diagnostic");
  });

  it("preserves a safe user-facing 403 message while retaining the forbidden kind", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: "MODULE_NOT_ENTITLED",
      message: "Your current plan does not include this feature.",
    }, 403));

    await expect(requestJson("/api/example")).rejects.toMatchObject({
      kind: "forbidden",
      status: 403,
      message: "Your current plan does not include this feature.",
      code: "MODULE_NOT_ENTITLED",
    });
  });

  it("never exposes response details or error codes from JSON 500 responses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: "PrismaClientKnownRequestError: DATABASE_URL=private",
      message: "Database connection failed at /app/server.ts:42\n    at query (stack trace)",
    }, 500));

    const error = await requestJson("/api/example").catch((caught: unknown) => caught);

    expectApiRequestError(error);
    expect(error).toMatchObject({ kind: "http", status: 500, code: undefined });
    expect(error.message).toBe("The server encountered an error. Please try again later.");
    expect(apiErrorMessage(error, "fallback")).not.toMatch(/Prisma|DATABASE_URL|server\.ts|stack trace/i);
  });

  it("safely handles non-JSON and malformed JSON 500 responses", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("upstream host 10.0.0.2", { status: 500 }))
      .mockResolvedValueOnce(new Response("{malformed private response", { status: 500 }));

    for (let index = 0; index < 2; index += 1) {
      const error = await requestJson("/api/example").catch((caught: unknown) => caught);
      expectApiRequestError(error);
      expect(error).toMatchObject({ kind: "http", status: 500 });
      expect(error.message).toBe("The server encountered an error. Please try again later.");
      expect(error.message).not.toContain("10.0.0.2");
    }
  });

  it("preserves safe 4xx validation messages", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Enter valid check-in and check-out dates." }, 400));

    await expect(requestJson("/api/example")).rejects.toMatchObject({
      kind: "http",
      status: 400,
      message: "Enter valid check-in and check-out dates.",
    });
  });

  it.each([
    ["malformed", new Response("{not valid JSON", { status: 200 }), 200],
    ["empty", new Response(null, { status: 200 }), 200],
    ["empty 204", new Response(null, { status: 204 }), 204],
  ])("rejects %s successful responses with a typed invalid-response error", async (_name, response, status) => {
    fetchMock.mockResolvedValueOnce(response);

    await expect(requestJson("/api/example")).rejects.toMatchObject({
      kind: "invalid-response",
      status,
      message: "The server returned an invalid response. Please try again.",
    });
  });

  it("converts network failures without exposing the low-level exception", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED database.internal:5432"));

    const error = await requestJson("/api/example").catch((caught: unknown) => caught);

    expectApiRequestError(error);
    expect(error).toMatchObject({ kind: "network", status: undefined });
    expect(error.message).toBe("Unable to reach the server. Check your connection and try again.");
    expect(apiErrorMessage(error, "fallback")).not.toContain("database.internal");
  });
});
