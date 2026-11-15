/**
 * Failure modes of the pricing configuration layer.
 *
 * Pricing must fail closed. A price may only be produced from a *complete* and
 * *current* configuration, so every pricing reader either returns a fully loaded
 * configuration or throws one of these errors. Nothing in the pricing path may
 * turn "I could not read the configuration" into "this hotel has no optional
 * rules" — that difference decides whether a guest is charged correctly.
 *
 * Two audiences are served separately:
 *   - `message`  is safe to return to an API caller or show in the UI;
 *   - `detail`   is for server logs only (it may name models, files or drivers).
 */

export type PricingUnavailableCode =
  /** The generated Prisma Client is older than prisma/schema.prisma. */
  | "PRISMA_CLIENT_STALE"
  /** The database has not had the pricing migrations applied. */
  | "PRICING_TABLES_MISSING"
  /** The database rejected / failed the configuration read. */
  | "PRICING_CONFIG_UNREADABLE"
  /** The hotel's own configuration cannot produce a correct price. */
  | "PRICING_CONFIG_INVALID";

const MESSAGES: Record<PricingUnavailableCode, string> = {
  PRISMA_CLIENT_STALE:
    "Pricing is unavailable because the server's database client is out of date. " +
    "An administrator must regenerate the Prisma Client (npx prisma generate) and restart the application.",
  PRICING_TABLES_MISSING:
    "Pricing is unavailable because the pricing database tables have not been created. " +
    "An administrator must apply the pending database migrations.",
  PRICING_CONFIG_UNREADABLE:
    "Pricing could not be read from the database, so no price can be quoted. " +
    "Please try again; if it keeps happening, contact an administrator.",
  PRICING_CONFIG_INVALID:
    "This hotel's pricing configuration is incomplete, so a correct price cannot be calculated.",
};

export class PricingUnavailableError extends Error {
  readonly code: PricingUnavailableCode;
  /** HTTP status for API callers: pricing being unavailable is not a client error. */
  readonly status = 503;
  /** Server-side only. Never returned to a browser. */
  readonly detail: string;

  constructor(code: PricingUnavailableCode, detail: string, message?: string, options?: { cause?: unknown }) {
    super(message ?? MESSAGES[code], options as ErrorOptions | undefined);
    this.name = "PricingUnavailableError";
    this.code = code;
    this.detail = detail;
  }

  toResponseBody(): { error: string; code: PricingUnavailableCode } {
    return { error: this.message, code: this.code };
  }
}

export function isPricingUnavailable(error: unknown): error is PricingUnavailableError {
  return error instanceof PricingUnavailableError;
}

/** Message a manager can act on: the configuration itself is wrong or incomplete. */
export function invalidPricingConfig(detail: string, message: string): PricingUnavailableError {
  return new PricingUnavailableError("PRICING_CONFIG_INVALID", detail, message);
}

/** Prisma's "relation/table does not exist" — the migrations were never applied. */
export function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "P2021" || code === "P2022") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /relation .* does not exist|table .* does not exist|column .* does not exist/i.test(message);
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
