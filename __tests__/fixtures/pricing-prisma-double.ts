/**
 * Pricing delegates for Prisma doubles.
 *
 * `lib/pricing/config.ts` refuses to price without a complete configuration: a
 * missing delegate is now `PRISMA_CLIENT_STALE` (and a 503), not an empty
 * configuration silently priced from `RoomType.baseRate`. A real Prisma Client
 * always exposes these delegates, so a test double that wants the legacy
 * `LEGACY_BASE_RATE` path must expose them too — returning no rows, which is
 * exactly what a hotel that never opened the Pricing page has.
 *
 * Use it inside a `vi.doMock("@/lib/prisma")` factory:
 *
 *   prisma: {
 *     ...pricingModelStubs(),
 *     reservation: { ... },
 *   }
 *
 * Pass `rows` to model a hotel that *has* pricing configuration.
 */

export type PricingStubRows = {
  hotelPricingSettings?: unknown[];
  hotel?: unknown[];
  roomType?: unknown[];
  occupancyType?: unknown[];
  roomTypeOccupancy?: unknown[];
  mealPlanConfig?: unknown[];
  mealPlanRoomType?: unknown[];
  rateAdjustment?: unknown[];
  extraBedRule?: unknown[];
  childPricingRule?: unknown[];
  taxRule?: unknown[];
};

const EMPTY: Required<PricingStubRows> = {
  hotelPricingSettings: [],
  hotel: [],
  roomType: [],
  occupancyType: [],
  roomTypeOccupancy: [],
  mealPlanConfig: [],
  mealPlanRoomType: [],
  rateAdjustment: [],
  extraBedRule: [],
  childPricingRule: [],
  taxRule: [],
};

export function pricingModelStubs(rows: PricingStubRows = {}): Record<string, { findMany: (args?: unknown) => Promise<unknown[]> }> {
  const data = { ...EMPTY, ...rows };
  return Object.fromEntries(
    Object.entries(data).map(([model, list]) => [
      model,
      { findMany: async () => list },
    ])
  );
}
