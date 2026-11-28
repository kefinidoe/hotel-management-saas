// Centralized SaaS Subscription Room Bands and Pricing Configuration
// Single source of truth for room bands, configurable pricing schedules, and core platform entitlements.
import Decimal from "decimal.js";

export const SubscriptionStatus = {
  TRIALING: "TRIALING",
  ACTIVE: "ACTIVE",
  PAST_DUE: "PAST_DUE",
  RESTRICTED: "RESTRICTED",
  READ_ONLY: "READ_ONLY",
  SUSPENDED: "SUSPENDED",
  CANCELLED: "CANCELLED",
} as const;

export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export const SubscriptionInvoiceStatus = {
  ISSUED: "ISSUED",
  PAID: "PAID",
  PAST_DUE: "PAST_DUE",
  VOID: "VOID",
} as const;

export type SubscriptionInvoiceStatus = (typeof SubscriptionInvoiceStatus)[keyof typeof SubscriptionInvoiceStatus];

export const BillingInterval = {
  MONTHLY: "MONTHLY",
  YEARLY: "YEARLY",
} as const;

export type BillingInterval = (typeof BillingInterval)[keyof typeof BillingInterval];

export type SaaSModule =
  | "RESERVATIONS"
  | "FOLIOS"
  | "HOUSEKEEPING"
  | "RESTAURANT_POS"
  | "INVENTORY"
  | "EXPENSES"
  | "MAINTENANCE"
  | "REPORTS";

/**
 * Core hotel-management features available across all room bands.
 * As per product decision, core features (including restaurant POS, inventory, reports)
 * are not restricted solely because a hotel is in a lower-priced room band.
 */
export const ALL_CORE_MODULES: SaaSModule[] = [
  "RESERVATIONS",
  "FOLIOS",
  "HOUSEKEEPING",
  "RESTAURANT_POS",
  "INVENTORY",
  "EXPENSES",
  "MAINTENANCE",
  "REPORTS",
];

export interface PlanUsageLimits {
  maxRooms: number;
  maxStaff: number;
}

/**
 * Configurable Room Band Definition
 */
export interface RoomBand {
  id: string;
  name: string;
  tagline: string;
  description: string;
  minRooms: number;
  maxRooms: number; // Infinity for custom quote band
  isCustomQuote: boolean;
  trialDurationDays: number;
  monthlyPriceKES: number;
  monthlyPriceUSD: number;
  yearlyPriceKES: number;
  yearlyPriceUSD: number;
  annualDiscountPercentage: number;
  modules: SaaSModule[];
  limits: PlanUsageLimits;
  isActive: boolean; // available for new subscriptions
  badge?: string;
}

// Backward-compatible type alias
export type SubscriptionPlan = RoomBand;

/**
 * Product-level pricing schedule configuration.
 * Note: Baseline pricing schedules are placeholder configurations until final MIK Tech executive schedule approval.
 */
export interface PricingConfiguration {
  isScheduleApproved: boolean;
  defaultAnnualDiscountPercent: number;
  trialDurationDays: number;
  supportedCurrencies: ("KES" | "USD")[];
  defaultCurrency: "KES";
  notes: string;
}

export const PRICING_CONFIG: PricingConfiguration = {
  isScheduleApproved: false, // Baseline placeholder pricing pending executive sign-off
  defaultAnnualDiscountPercent: 16.67, // Equivalent to ~2 months free on an annual plan (pay for 10 months)
  trialDurationDays: 30,
  supportedCurrencies: ["KES", "USD"],
  defaultCurrency: "KES",
  notes: "Configurable baseline pricing schedule pending final business approval. Final prices to be set before commercial launch.",
};

/**
 * Standard Ordered Room Bands
 * 1. 1–10 rooms
 * 2. 11–25 rooms
 * 3. 26–50 rooms
 * 4. 51–100 rooms
 * 5. 101–200 rooms
 * 6. 201+ rooms (Custom quote)
 */
export const ORDERED_ROOM_BANDS: RoomBand[] = [
  {
    id: "BAND_1_10",
    name: "1–10 Rooms",
    tagline: "Boutique, B&B, and small lodge operations",
    description: "Complete hotel management platform for properties with up to 10 rooms. Includes POS, inventory, front desk, and reports.",
    minRooms: 1,
    maxRooms: 10,
    isCustomQuote: false,
    trialDurationDays: 30,
    monthlyPriceKES: 3500, // Baseline placeholder
    monthlyPriceUSD: 28,
    yearlyPriceKES: 35000, // 10 months (2 months free)
    yearlyPriceUSD: 280,
    annualDiscountPercentage: 16.67,
    modules: ALL_CORE_MODULES,
    limits: {
      maxRooms: 10,
      maxStaff: 10,
    },
    isActive: true,
  },
  {
    id: "BAND_11_25",
    name: "11–25 Rooms",
    tagline: "Independent hotels, guest houses, and safari camps",
    description: "Full-scale hotel operations for mid-sized boutique properties with up to 25 rooms. All features included.",
    minRooms: 11,
    maxRooms: 25,
    isCustomQuote: false,
    trialDurationDays: 30,
    monthlyPriceKES: 6500, // Baseline placeholder
    monthlyPriceUSD: 52,
    yearlyPriceKES: 65000,
    yearlyPriceUSD: 520,
    annualDiscountPercentage: 16.67,
    modules: ALL_CORE_MODULES,
    limits: {
      maxRooms: 25,
      maxStaff: 25,
    },
    isActive: true,
    badge: "Popular",
  },
  {
    id: "BAND_26_50",
    name: "26–50 Rooms",
    tagline: "Commercial hotels, town lodges, and resort wings",
    description: "Multi-department operational control for hotels with up to 50 rooms. POS, recipes, stock control, and team access.",
    minRooms: 26,
    maxRooms: 50,
    isCustomQuote: false,
    trialDurationDays: 30,
    monthlyPriceKES: 11000, // Baseline placeholder
    monthlyPriceUSD: 88,
    yearlyPriceKES: 110000,
    yearlyPriceUSD: 880,
    annualDiscountPercentage: 16.67,
    modules: ALL_CORE_MODULES,
    limits: {
      maxRooms: 50,
      maxStaff: 50,
    },
    isActive: true,
  },
  {
    id: "BAND_51_100",
    name: "51–100 Rooms",
    tagline: "Full-service hotels, conference centers, and large lodges",
    description: "High-volume guest flow and team collaboration across multiple outlets, dining rooms, and room wings.",
    minRooms: 51,
    maxRooms: 100,
    isCustomQuote: false,
    trialDurationDays: 30,
    monthlyPriceKES: 18500, // Baseline placeholder
    monthlyPriceUSD: 148,
    yearlyPriceKES: 185000,
    yearlyPriceUSD: 1480,
    annualDiscountPercentage: 16.67,
    modules: ALL_CORE_MODULES,
    limits: {
      maxRooms: 100,
      maxStaff: 100,
    },
    isActive: true,
  },
  {
    id: "BAND_101_200",
    name: "101–200 Rooms",
    tagline: "Resorts, club hotels, and major hospitality establishments",
    description: "Enterprise-grade throughput, maintenance dispatching, full revenue reporting, and inventory across departments.",
    minRooms: 101,
    maxRooms: 200,
    isCustomQuote: false,
    trialDurationDays: 30,
    monthlyPriceKES: 28000, // Baseline placeholder
    monthlyPriceUSD: 224,
    yearlyPriceKES: 280000,
    yearlyPriceUSD: 2240,
    annualDiscountPercentage: 16.67,
    modules: ALL_CORE_MODULES,
    limits: {
      maxRooms: 200,
      maxStaff: 200,
    },
    isActive: true,
  },
  {
    id: "BAND_201_PLUS",
    name: "201+ Rooms (Enterprise Custom)",
    tagline: "Large hotel groups, resort complexes, and multi-property chains",
    description: "Tailored multi-property deployment, custom integration schedules, dedicated support, and negotiated SLA.",
    minRooms: 201,
    maxRooms: Infinity,
    isCustomQuote: true,
    trialDurationDays: 30,
    monthlyPriceKES: 0,
    monthlyPriceUSD: 0,
    yearlyPriceKES: 0,
    yearlyPriceUSD: 0,
    annualDiscountPercentage: 0,
    modules: ALL_CORE_MODULES,
    limits: {
      maxRooms: Infinity,
      maxStaff: Infinity,
    },
    isActive: true,
    badge: "Custom Quote",
  },
];

/**
 * Legacy tier mappings for backward compatibility with existing subscriptions and tests
 */
const LEGACY_TIER_MAPPINGS: Record<string, RoomBand> = {
  STARTER: {
    ...ORDERED_ROOM_BANDS[0], // BAND_1_10
    id: "STARTER",
    name: "Starter (Legacy 1–15 Rooms)",
    limits: { maxRooms: 15, maxStaff: 5 },
  },
  GROWTH: {
    ...ORDERED_ROOM_BANDS[2], // BAND_26_50
    id: "GROWTH",
    name: "Growth (Legacy 16–50 Rooms)",
    limits: { maxRooms: 50, maxStaff: 25 },
  },
  ENTERPRISE: {
    ...ORDERED_ROOM_BANDS[5], // BAND_201_PLUS
    id: "ENTERPRISE",
    name: "Enterprise (Legacy Unlimited)",
    limits: { maxRooms: Infinity, maxStaff: Infinity },
  },
  LEGACY_BASIC: {
    ...ORDERED_ROOM_BANDS[0],
    id: "LEGACY_BASIC",
    name: "Legacy Basic (Grandfathered)",
    limits: { maxRooms: 10, maxStaff: 3 },
    isActive: false,
  },
};

/**
 * Complete plan directory combining new room bands and legacy aliases
 */
export const SUBSCRIPTION_PLANS: Record<string, RoomBand> = {
  ...ORDERED_ROOM_BANDS.reduce((acc, band) => {
    acc[band.id] = band;
    return acc;
  }, {} as Record<string, RoomBand>),
  ...LEGACY_TIER_MAPPINGS,
};

export const DEFAULT_PLAN_ID = "BAND_1_10";

/**
 * The price schedule is published in KES and USD only. A hotel may record
 * operations in another currency (EUR, GBP, ...), but its subscription is still
 * billed in one of these two; mapping anything else to KES keeps the billed
 * currency and the displayed  price schedule in agreement.
 */
export function normaliseBillingCurrency(currency: string | null | undefined): "KES" | "USD" {
  return (currency ?? "KES").toUpperCase() === "USD" ? "USD" : "KES";
}

/**
 * Server-side price for a stored subscription, in the currency it is billed in.
 * Returns null for unknown plans and custom-quote bands (which have no list
 * price), so callers never invent an amount.
 */
export function priceForSubscription(params: {
  planId: string;
  billingInterval?: BillingInterval;
  currency?: string | null;
}): number | null {
  const plan = SUBSCRIPTION_PLANS[(params.planId ?? "").toUpperCase()];
  if (!plan || plan.isCustomQuote) return null;
  const usd = normaliseBillingCurrency(params.currency) === "USD";
  if (params.billingInterval === BillingInterval.YEARLY) {
    return usd ? plan.yearlyPriceUSD : plan.yearlyPriceKES;
  }
  return usd ? plan.monthlyPriceUSD : plan.monthlyPriceKES;
}

/**
 * Returns the RoomBand matching a specific billable room count.
 * Handles edge cases (0 rooms defaults to Band 1, negative numbers normalized).
 */
export function getBandForRoomCount(roomCount: number): RoomBand {
  const count = Math.max(0, Math.floor(roomCount));
  // 0 rooms (new hotel without rooms yet) belongs to the entry band
  if (count <= 10) return ORDERED_ROOM_BANDS[0];
  if (count <= 25) return ORDERED_ROOM_BANDS[1];
  if (count <= 50) return ORDERED_ROOM_BANDS[2];
  if (count <= 100) return ORDERED_ROOM_BANDS[3];
  if (count <= 200) return ORDERED_ROOM_BANDS[4];
  return ORDERED_ROOM_BANDS[5]; // 201+ Custom Quote
}

/**
 * Server-side calculation of subscription price based on:
 * - Billable room count
 * - Selected billing interval (Monthly vs Yearly)
 * - Currency (KES or USD)
 * - Effective pricing configuration
 */
export interface BandPricingCalculation {
  band: RoomBand;
  billableRoomCount: number;
  billingInterval: BillingInterval;
  currency: "KES" | "USD";
  isCustomQuote: boolean;
  baseMonthlyPrice: number;
  calculatedPrice: number; // Total price billed for the interval
  monthlyEquivalent: number; // MRR normalized
  annualDiscountPercentage: number;
  savingsVsMonthly: number;
  pricingScheduleNote: string;
}

export function calculateBandPricing(params: {
  roomCount: number;
  billingInterval?: BillingInterval;
  currency?: string;
}): BandPricingCalculation {
  const {
    roomCount,
    billingInterval = BillingInterval.MONTHLY,
    currency = "KES",
  } = params;

  const band = getBandForRoomCount(roomCount);
  const normalizedCurrency: "KES" | "USD" = currency.toUpperCase() === "USD" ? "USD" : "KES";
  const isUSD = normalizedCurrency === "USD";
  const baseMonthlyPrice = isUSD ? band.monthlyPriceUSD : band.monthlyPriceKES;

  if (band.isCustomQuote) {
    return {
      band,
      billableRoomCount: roomCount,
      billingInterval,
      currency: normalizedCurrency,
      isCustomQuote: true,
      baseMonthlyPrice: 0,
      calculatedPrice: 0,
      monthlyEquivalent: 0,
      annualDiscountPercentage: 0,
      savingsVsMonthly: 0,
      pricingScheduleNote: "Custom quote required for properties with over 200 rooms. Contact sales for multi-property agreement.",
    };
  }

  let calculatedPrice = baseMonthlyPrice;
  let monthlyEquivalent = baseMonthlyPrice;
  let savings = 0;

  if (billingInterval === BillingInterval.YEARLY) {
    const fullYearCost = new Decimal(baseMonthlyPrice).mul(12);
    calculatedPrice = isUSD ? band.yearlyPriceUSD : band.yearlyPriceKES;
    const yearlyDecimal = new Decimal(calculatedPrice);
    monthlyEquivalent = yearlyDecimal.div(12).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
    savings = fullYearCost.minus(yearlyDecimal).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
  }

  return {
    band,
    billableRoomCount: roomCount,
    billingInterval,
    currency: normalizedCurrency,
    isCustomQuote: false,
    baseMonthlyPrice,
    calculatedPrice,
    monthlyEquivalent,
    annualDiscountPercentage: band.annualDiscountPercentage,
    savingsVsMonthly: savings,
    pricingScheduleNote: PRICING_CONFIG.isScheduleApproved
      ? "Standard approved pricing schedule."
      : "Configurable baseline pricing schedule (placeholder subject to final MIK Tech executive schedule approval).",
  };
}

/**
 * Retrieves a plan or room band by ID. Falls back safely to DEFAULT_PLAN_ID.
 */
export function getPlan(planId: string | null | undefined): RoomBand {
  if (!planId) return SUBSCRIPTION_PLANS[DEFAULT_PLAN_ID];
  const upper = planId.toUpperCase();
  return SUBSCRIPTION_PLANS[upper] || SUBSCRIPTION_PLANS[DEFAULT_PLAN_ID];
}

/**
 * Retrieves all active room bands for comparison and upgrades.
 */
export function getAllPlans(onlyActive = false): RoomBand[] {
  // Return the official room bands in order
  return onlyActive ? ORDERED_ROOM_BANDS.filter((b) => b.isActive) : ORDERED_ROOM_BANDS;
}

/**
 * Verifies if a given room band or plan ID is available for new subscriptions.
 */
export function isPlanAvailableForNewSub(planId: string): boolean {
  const plan = SUBSCRIPTION_PLANS[planId.toUpperCase()];
  return Boolean(plan && plan.isActive);
}
