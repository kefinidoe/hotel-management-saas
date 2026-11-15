/**
 * Types for the hotel-configurable pricing engine.
 *
 * The engine itself (`lib/pricing/engine.ts`) is pure: it takes a snapshot of one
 * hotel's configuration plus a request, and returns a full price breakdown. Both
 * the quote endpoint and reservation creation call it, so the screen and the
 * database can never disagree about what a stay costs.
 */

export type PricingModel = "ROOM_TYPE_OCCUPANCY" | "LEGACY_BASE_RATE";

export type MealPlanPricingBasis =
  | "PER_PERSON_PER_NIGHT"
  | "PER_ROOM_PER_NIGHT"
  | "PER_PERSON_PER_STAY"
  | "PER_ROOM_PER_STAY";

export type RateAdjustmentKind = "SEASONAL" | "WEEKEND";
export type RateAdjustmentType = "PERCENT" | "FIXED_PER_NIGHT" | "SET_RATE";
export type ChildChargeType = "FIXED_PER_NIGHT" | "PERCENT_OF_ADULT";
export type TaxBasis = "PERCENT" | "FIXED";
export type TaxAppliesTo = "ROOM" | "MEALS" | "ALL";
export type TaxChargeBasis = "PER_NIGHT" | "PER_STAY" | "PER_PERSON_PER_NIGHT";

export type PricingSettings = {
  pricingModel: PricingModel;
  useOccupancyRates: boolean;
  useMealPlans: boolean;
  useSeasonalPricing: boolean;
  useWeekendPricing: boolean;
  useChildPricing: boolean;
  useExtraBeds: boolean;
  useTaxes: boolean;
  pricesIncludeTax: boolean;
};

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  pricingModel: "LEGACY_BASE_RATE",
  useOccupancyRates: false,
  useMealPlans: false,
  useSeasonalPricing: false,
  useWeekendPricing: false,
  useChildPricing: false,
  useExtraBeds: false,
  useTaxes: false,
  pricesIncludeTax: false,
};

export type RoomTypeConfig = {
  id: string;
  name: string;
  baseRate: number;
  capacity: number;
};

export type OccupancyConfig = {
  id: string;
  name: string;
  minAdults: number;
  maxAdults: number;
  maxChildren: number;
  sortOrder: number;
  isActive: boolean;
};

export type RoomTypeOccupancyConfig = {
  roomTypeId: string;
  occupancyTypeId: string;
  nightlyRate: number;
  isActive: boolean;
};

export type MealPlanConfig = {
  id: string;
  name: string;
  pricingBasis: MealPlanPricingBasis;
  charge: number;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  isActive: boolean;
  /** Empty = available for every room type. */
  roomTypeIds: string[];
};

export type RateAdjustmentConfig = {
  id: string;
  name: string;
  kind: RateAdjustmentKind;
  adjustmentType: RateAdjustmentType;
  amount: number;
  /** 0 = Sunday. Only meaningful for WEEKEND adjustments. */
  daysOfWeek: number[];
  startDate: Date | null;
  endDate: Date | null;
  roomTypeId: string | null;
  priority: number;
  isActive: boolean;
};

export type ExtraBedRuleConfig = {
  id: string;
  name: string;
  roomTypeId: string | null;
  nightlyRate: number;
  childRate: number | null;
  maxPerRoom: number;
  isActive: boolean;
};

export type ChildPricingRuleConfig = {
  id: string;
  name: string;
  minAge: number;
  maxAge: number;
  chargeType: ChildChargeType;
  amount: number;
  isActive: boolean;
};

export type TaxRuleConfig = {
  id: string;
  name: string;
  basis: TaxBasis;
  amount: number;
  appliesTo: TaxAppliesTo;
  chargeBasis: TaxChargeBasis;
  isInclusive: boolean;
  sortOrder: number;
  isActive: boolean;
};

/** Everything the engine is allowed to read, already scoped to one hotel. */
export type HotelPricingConfig = {
  hotelId: string;
  currency: string;
  settings: PricingSettings;
  roomTypes: RoomTypeConfig[];
  occupancies: OccupancyConfig[];
  roomTypeOccupancies: RoomTypeOccupancyConfig[];
  mealPlans: MealPlanConfig[];
  adjustments: RateAdjustmentConfig[];
  extraBeds: ExtraBedRuleConfig[];
  childRules: ChildPricingRuleConfig[];
  taxes: TaxRuleConfig[];
};

export type PriceRequest = {
  roomTypeId: string;
  occupancyTypeId?: string | null;
  mealPlanId?: string | null;
  checkIn: Date;
  checkOut: Date;
  adults: number;
  children?: number;
  childAges?: number[];
  extraBeds?: number;
  /** Fixed-amount discount, in the hotel currency. */
  discount?: number;
  /** Percentage discount (0-100). Mutually exclusive with `discount`. */
  discountPercent?: number;
};

export type PriceLineKind =
  | "ROOM"
  | "ADJUSTMENT"
  | "MEAL_PLAN"
  | "EXTRA_BED"
  | "CHILD"
  | "DISCOUNT"
  | "TAX";

export type PriceLine = {
  kind: PriceLineKind;
  code: string;
  label: string;
  quantity: number;
  unitPrice: number;
  amount: number;
};

export type NightPrice = {
  /** ISO date (UTC) of the night. */
  date: string;
  baseRate: number;
  /** Effective rate for this night after seasonal/weekend adjustments. */
  rate: number;
  /** Names of the adjustments applied, for the breakdown. */
  adjustments: string[];
};

export type PriceBreakdown = {
  ok: true;
  currency: string;
  pricingModel: PricingModel | "MODULAR_PRICING";
  nights: number;
  roomTypeId: string;
  roomTypeName: string;
  occupancyTypeId: string | null;
  occupancyName: string | null;
  mealPlanId: string | null;
  mealPlanName: string | null;
  mealPlanBasis: MealPlanPricingBasis | null;
  nightlyRate: number;
  effectiveNightlyRate: number;
  adults: number;
  children: number;
  extraBeds: number;
  perNight: NightPrice[];
  lines: PriceLine[];
  totals: {
    room: number;
    adjustments: number;
    meals: number;
    extras: number;
    subtotal: number;
    discount: number;
    tax: number;
    grandTotal: number;
    /** Average nightly cost including meals/extras/tax, for display. */
    averagePerNight: number;
  };
  taxInclusive: boolean;
};

export type PriceFailureCode =
  | "ROOM_TYPE_NOT_FOUND"
  | "OCCUPANCY_REQUIRED"
  | "OCCUPANCY_NOT_AVAILABLE"
  | "UNSUPPORTED_OCCUPANCY"
  | "CAPACITY_EXCEEDED"
  | "RATE_NOT_CONFIGURED"
  | "INVALID_DATES"
  | "INVALID_GUESTS"
  | "MEAL_PLAN_NOT_AVAILABLE"
  | "INVALID_DISCOUNT"
  | "EXTRA_BEDS_UNAVAILABLE"
  | "INVALID_CONFIG";

export type PriceFailure = {
  ok: false;
  code: PriceFailureCode;
  message: string;
};

export type PriceResult = PriceBreakdown | PriceFailure;
