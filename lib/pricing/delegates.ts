/**
 * The Prisma models the pricing engine reads, and a guard that proves the client
 * in hand can actually reach them.
 *
 * Why this exists: a Prisma Client generated from an older schema still accepts
 * `prisma.hotel`, but `prisma.hotelPricingSettings` is simply `undefined`, so the
 * first pricing call dies with `TypeError: Cannot read properties of undefined
 * (reading 'findUnique')` — an error that says nothing about the real problem.
 * The guard below turns that into a named, actionable failure
 * (`PRISMA_CLIENT_STALE`) and is enforced at three depths:
 *
 *   1. at application start-up (`lib/prisma.ts`),
 *   2. at every pricing read (`lib/pricing/config.ts`, `lib/pricing/admin.ts`),
 *   3. in the build (`scripts/check-prisma-client.mjs`).
 */

import { PricingUnavailableError, describeError } from "./errors";

/** Delegates required to price a stay or administer a hotel's pricing. */
export const PRICING_MODEL_DELEGATES = [
  "hotel",
  "roomType",
  "hotelPricingSettings",
  "occupancyType",
  "roomTypeOccupancy",
  "mealPlanConfig",
  "mealPlanRoomType",
  "rateAdjustment",
  "extraBedRule",
  "childPricingRule",
  "taxRule",
] as const;

export type PricingModelName = (typeof PRICING_MODEL_DELEGATES)[number];

type Delegate = { findMany: (args: unknown) => Promise<unknown[]>, [key: string]: unknown };

function isDelegate(value: unknown): value is Delegate {
  return typeof value === "object" && value !== null && typeof (value as Delegate).findMany === "function";
}

/** Names from `PRICING_MODEL_DELEGATES` the client cannot serve. */
export function missingPricingDelegates(client: unknown): PricingModelName[] {
  if (!client || typeof client !== "object") return [...PRICING_MODEL_DELEGATES];
  const source = client as Record<string, unknown>;
  return PRICING_MODEL_DELEGATES.filter((name) => !isDelegate(source[name]));
}

/**
 * Throw `PRISMA_CLIENT_STALE` unless every pricing delegate is present.
 *
 * @param context where the check ran, for the server log ("pricing configuration read")
 */
export function assertPricingDelegates(client: unknown, context: string): void {
  const missing = missingPricingDelegates(client);
  if (missing.length === 0) return;
  throw new PricingUnavailableError(
    "PRISMA_CLIENT_STALE",
    `Prisma Client is missing pricing delegate(s) ${missing.join(", ")} (checked at ${context}). ` +
      "node_modules/.prisma/client was generated from an older schema: run `npx prisma generate` " +
      "and restart the process (a running server keeps the previous client in memory)."
  );
}

/** Fetch one delegate, refusing to continue if the client cannot serve it. */
export function requirePricingDelegate(client: unknown, name: PricingModelName, context: string): Delegate {
  const source = (client ?? null) as Record<string, unknown> | null;
  const delegate = source ? source[name] : undefined;
  if (!isDelegate(delegate)) {
    assertPricingDelegates(client, `${context} → ${name}`);
    // `assertPricingDelegates` above already explains what is missing; this line
    // only keeps TypeScript and readers honest if the delegate vanished mid-check.
    throw new PricingUnavailableError(
      "PRISMA_CLIENT_STALE",
      `Prisma Client cannot serve the "${name}" model (checked at ${context}).`
    );
  }
  return delegate;
}

/** Log a pricing failure with the full server-side detail. */
export function logPricingFailure(error: unknown, context: string): void {
  if (error instanceof PricingUnavailableError) {
    console.error(`[pricing] ${context} failed (${error.code}): ${error.detail}`);
    return;
  }
  console.error(`[pricing] ${context} failed: ${describeError(error)}`);
}
