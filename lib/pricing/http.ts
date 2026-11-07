import { NextResponse } from "next/server";
import { isPricingUnavailable } from "./errors";
import { logPricingFailure } from "./delegates";

/**
 * Turn a `PricingUnavailableError` into a 503 for the caller.
 *
 * Pricing failures are infrastructure/configuration failures, not bad requests:
 * a 503 plus a machine-readable `code` lets the UI say "pricing is unavailable,
 * nothing was charged" instead of showing a generic 500 or, worse, letting the
 * caller retry into a wrong price. The full cause is logged server-side only.
 *
 * Returns `null` for any other error so the route keeps its existing handling.
 */
export function pricingUnavailableResponse(error: unknown, context: string): NextResponse | null {
  if (!isPricingUnavailable(error)) return null;
  logPricingFailure(error, context);
  return NextResponse.json(error.toResponseBody(), { status: error.status });
}
