import { prisma } from "@/lib/prisma";
import {
  getBandForRoomCount,
  calculateBandPricing,
  BandPricingCalculation,
  RoomBand,
  SaaSModule,
  SUBSCRIPTION_PLANS,
  SubscriptionStatus,
  BillingInterval,
} from "./plans";

export const HotelStatus = {
  ACTIVE: "ACTIVE",
  TRIALING: "TRIALING",
  SUSPENDED: "SUSPENDED",
  CANCELLED: "CANCELLED",
} as const;
export type HotelStatus = (typeof HotelStatus)[keyof typeof HotelStatus];

export type EvaluatedSubscriptionState =
  | "TRIALING"
  | "TRIAL_EXPIRED"
  | "ACTIVE"
  | "PAST_DUE"
  | "SUSPENDED"
  | "CANCELLED";

export const PAST_DUE_GRACE_PERIOD_DAYS = 7;

export class SubscriptionStatusUnavailableError extends Error {
  readonly code = "SUBSCRIPTION_STATUS_UNAVAILABLE";
  readonly statusCode = 503;

  constructor(message = "Subscription status is temporarily unavailable.") {
    super(message);
    this.name = "SubscriptionStatusUnavailableError";
  }
}

export interface HotelSubscriptionContext {
  id: string;
  hotelId: string;
  planId: string;
  plan: RoomBand;
  storedStatus: SubscriptionStatus;
  effectiveStatus: EvaluatedSubscriptionState;
  isOperational: boolean; // can perform active operational tasks
  trialStartsAt: Date;
  trialEndsAt: Date | null;
  currentPeriodStartsAt: Date;
  currentPeriodEndsAt: Date | null;
  daysRemaining: number | null;
  isOverdue: boolean;
  cancelAtPeriodEnd: boolean;
  suspensionReason: string | null;
  billingInterval: BillingInterval;
  amount: number;
  currency: string;
}

export interface EntitlementCheckResult {
  allowed: boolean;
  reason?: string;
  code?: string;
  module?: SaaSModule;
  effectiveStatus: EvaluatedSubscriptionState;
  planId: string;
  planName: string;
}

export interface UsageLimitCheckResult {
  allowed: boolean;
  limitType: "maxRooms" | "maxStaff";
  currentCount: number;
  maxLimit: number;
  planId: string;
  planName: string;
  recommendedNextBand?: string;
  reason?: string;
  code?: string;
}

export interface BillableRoomBreakdown {
  totalConfiguredRooms: number;
  billableActiveRooms: number; // isActive: true (operational inventory)
  decommissionedRooms: number; // isActive: false (archived/decommissioned - non-billable)
  statusBreakdown: {
    available: number;
    occupied: number;
    reserved: number;
    dirty: number;
    outOfOrder: number; // temporary operational closure - billable
    maintenance: number; // temporary operational closure - billable
  };
  currentBand: RoomBand;
  recommendedBand: RoomBand;
  isOverBandCapacity: boolean;
  roomsRemainingInBand: number | null; // null for custom quote / infinity
}

/**
 * Evaluates server-authoritative subscription dates. Past-due accounts retain
 * operational access only until the configured grace deadline; missing or
 * malformed state is an infrastructure/data error, never an implicit ACTIVE.
 */
export function evaluateSubscriptionStatus(
  sub: {
    status: SubscriptionStatus;
    trialEndsAt?: Date | null;
    currentPeriodEndsAt?: Date | null;
  },
  now = new Date()
): {
  effectiveStatus: EvaluatedSubscriptionState;
  isOperational: boolean;
  isOverdue: boolean;
  daysRemaining: number | null;
} {
  const graceMilliseconds = PAST_DUE_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  const validDate = (value: Date | null | undefined) =>
    value == null || Number.isFinite(new Date(value).getTime());
  if (!validDate(sub.trialEndsAt) || !validDate(sub.currentPeriodEndsAt)) {
    throw new SubscriptionStatusUnavailableError("Subscription dates are invalid.");
  }

  if (sub.status === SubscriptionStatus.SUSPENDED) {
    return { effectiveStatus: "SUSPENDED", isOperational: false, isOverdue: false, daysRemaining: null };
  }
  if (sub.status === SubscriptionStatus.CANCELLED) {
    return { effectiveStatus: "CANCELLED", isOperational: false, isOverdue: false, daysRemaining: null };
  }
  if (sub.status === SubscriptionStatus.TRIALING) {
    if (!sub.trialEndsAt) {
      throw new SubscriptionStatusUnavailableError("Trial expiry is missing.");
    }
    const end = new Date(sub.trialEndsAt);
    if (now > end) {
      return { effectiveStatus: "TRIAL_EXPIRED", isOperational: false, isOverdue: true, daysRemaining: 0 };
    }
    return {
      effectiveStatus: "TRIALING",
      isOperational: true,
      isOverdue: false,
      daysRemaining: Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000)),
    };
  }
  if (sub.status === SubscriptionStatus.PAST_DUE) {
    if (!sub.currentPeriodEndsAt) {
      throw new SubscriptionStatusUnavailableError("Past-due subscription period end is missing.");
    }
    const end = new Date(sub.currentPeriodEndsAt);
    const graceEnd = new Date(end.getTime() + graceMilliseconds);
    const inGrace = now <= graceEnd;
    return {
      effectiveStatus: "PAST_DUE",
      isOperational: inGrace,
      isOverdue: true,
      daysRemaining: inGrace ? Math.max(0, Math.ceil((graceEnd!.getTime() - now.getTime()) / 86_400_000)) : 0,
    };
  }
  if (sub.status === SubscriptionStatus.ACTIVE) {
    if (!sub.currentPeriodEndsAt) {
      throw new SubscriptionStatusUnavailableError("Active subscription period end is missing.");
    }
    const end = new Date(sub.currentPeriodEndsAt);
    if (now > end) {
      const graceEnd = new Date(end.getTime() + graceMilliseconds);
      const inGrace = now <= graceEnd;
      return {
        effectiveStatus: "PAST_DUE",
        isOperational: inGrace,
        isOverdue: true,
        daysRemaining: inGrace ? Math.max(0, Math.ceil((graceEnd.getTime() - now.getTime()) / 86_400_000)) : 0,
      };
    }
    return {
      effectiveStatus: "ACTIVE",
      isOperational: true,
      isOverdue: false,
      daysRemaining: Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000)),
    };
  }

  throw new SubscriptionStatusUnavailableError("Subscription status is unrecognized.");
}

/**
 * Loads an existing subscription or initializes a missing row only after a
 * successful subscription lookup, hotel lookup, and room-count query. Upsert
 * is the sole creation path so concurrent initializers converge on one row.
 */
export async function getOrBootstrapSubscription(hotelId: string): Promise<HotelSubscriptionContext> {
  const subscriptionModel = (prisma as any).subscription;
  if (typeof subscriptionModel?.findUnique !== "function") {
    throw new SubscriptionStatusUnavailableError("Subscription storage is unavailable.");
  }

  let sub: any;
  try {
    sub = await subscriptionModel.findUnique({ where: { hotelId } });
  } catch {
    throw new SubscriptionStatusUnavailableError();
  }

  if (!sub) {
    let hotel: any;
    let activeRoomsCount: number;
    try {
      if (typeof (prisma as any).hotel?.findUnique !== "function") {
        throw new Error("Hotel storage unavailable");
      }
      hotel = await (prisma as any).hotel.findUnique({
        where: { id: hotelId },
        select: { id: true, status: true, createdAt: true, currency: true },
      });
      if (!hotel) throw new SubscriptionStatusUnavailableError("Hotel was not found while initializing its subscription.");
      if (typeof (prisma as any).room?.count !== "function") {
        throw new Error("Room count unavailable");
      }
      activeRoomsCount = await (prisma as any).room.count({ where: { hotelId, isActive: true } });
      if (!Number.isInteger(activeRoomsCount) || activeRoomsCount < 0) throw new Error("Invalid room count");
    } catch (error) {
      if (error instanceof SubscriptionStatusUnavailableError) throw error;
      throw new SubscriptionStatusUnavailableError("Hotel subscription could not be initialized safely.");
    }

    if (typeof subscriptionModel.upsert !== "function") {
      throw new SubscriptionStatusUnavailableError("Atomic subscription initialization is unavailable.");
    }
    const targetBand = getBandForRoomCount(activeRoomsCount);
    const trialStartsAt = hotel.createdAt ? new Date(hotel.createdAt) : new Date();
    if (!Number.isFinite(trialStartsAt.getTime())) {
      throw new SubscriptionStatusUnavailableError("Hotel creation date is invalid.");
    }
    const trialEndsAt = new Date(trialStartsAt.getTime() + targetBand.trialDurationDays * 86_400_000);
    const initialStatus =
      hotel.status === HotelStatus.SUSPENDED ? SubscriptionStatus.SUSPENDED :
      hotel.status === HotelStatus.CANCELLED ? SubscriptionStatus.CANCELLED :
      SubscriptionStatus.TRIALING;
    const currency = hotel.currency || "KES";
    const amount = currency === "USD" ? targetBand.monthlyPriceUSD : targetBand.monthlyPriceKES;
    const createPayload = {
      hotelId,
      planId: targetBand.id,
      status: initialStatus,
      trialStartsAt,
      trialEndsAt,
      currentPeriodStartsAt: trialStartsAt,
      currentPeriodEndsAt: trialEndsAt,
      amount,
      currency,
      billingInterval: BillingInterval.MONTHLY,
      metadata: {
        bootstrappedAt: new Date().toISOString(),
        initialRoomCount: activeRoomsCount,
        bandName: targetBand.name,
      },
    };

    try {
      sub = await subscriptionModel.upsert({ where: { hotelId }, update: {}, create: createPayload });
    } catch {
      // A competing upsert may have won. Re-read once; never infer a trial from
      // an unsuccessful write or an unavailable database.
      try {
        sub = await subscriptionModel.findUnique({ where: { hotelId } });
      } catch {
        throw new SubscriptionStatusUnavailableError();
      }
      if (!sub) throw new SubscriptionStatusUnavailableError("Subscription initialization failed.");
    }
  }

  const knownPlan = typeof sub?.planId === "string" ? SUBSCRIPTION_PLANS[sub.planId.toUpperCase()] : undefined;
  if (!sub || sub.hotelId !== hotelId || !knownPlan || !sub.id) {
    throw new SubscriptionStatusUnavailableError("Subscription record is incomplete or invalid.");
  }
  const evaluation = evaluateSubscriptionStatus({
    status: sub.status,
    trialEndsAt: sub.trialEndsAt,
    currentPeriodEndsAt: sub.currentPeriodEndsAt,
  });
  const trialStartsAt = sub.trialStartsAt ? new Date(sub.trialStartsAt) : null;
  const currentPeriodStartsAt = sub.currentPeriodStartsAt ? new Date(sub.currentPeriodStartsAt) : null;
  if (!trialStartsAt || !currentPeriodStartsAt || !Number.isFinite(trialStartsAt.getTime()) || !Number.isFinite(currentPeriodStartsAt.getTime())) {
    throw new SubscriptionStatusUnavailableError("Subscription dates are incomplete.");
  }

  return {
    id: sub.id,
    hotelId: sub.hotelId,
    planId: sub.planId,
    plan: knownPlan,
    storedStatus: sub.status,
    effectiveStatus: evaluation.effectiveStatus,
    isOperational: evaluation.isOperational,
    trialStartsAt,
    trialEndsAt: sub.trialEndsAt ? new Date(sub.trialEndsAt) : null,
    currentPeriodStartsAt,
    currentPeriodEndsAt: sub.currentPeriodEndsAt ? new Date(sub.currentPeriodEndsAt) : null,
    daysRemaining: evaluation.daysRemaining,
    isOverdue: evaluation.isOverdue,
    cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
    suspensionReason: sub.suspensionReason ?? null,
    billingInterval: sub.billingInterval || BillingInterval.MONTHLY,
    amount: typeof sub.amount === "number" ? sub.amount : Number(sub.amount) || 0,
    currency: sub.currency || "KES",
  };
}

/**
 * Checks whether the hotel's subscription is entitled to access a module.
 * In the Room-Band pricing model, all core modules are included across all room bands.
 * Fails closed if the subscription is non-operational (suspended, cancelled, or trial expired).
 */
export async function checkModuleEntitlement(
  hotelId: string,
  module: SaaSModule
): Promise<EntitlementCheckResult> {
  const sub = await getOrBootstrapSubscription(hotelId);
  const plan = sub.plan;

  // 1. Check subscription operational status
  if (!sub.isOperational) {
    if (sub.effectiveStatus === "SUSPENDED") {
      return {
        allowed: false,
        code: "SUBSCRIPTION_SUSPENDED",
        reason: `Hotel subscription is suspended (${sub.suspensionReason || "Administrative hold"}). Access to ${module} is locked.`,
        module,
        effectiveStatus: sub.effectiveStatus,
        planId: plan.id,
        planName: plan.name,
      };
    }

    if (sub.effectiveStatus === "TRIAL_EXPIRED") {
      return {
        allowed: false,
        code: "TRIAL_EXPIRED",
        reason: `Your 14-day trial has ended. Please activate your subscription to access ${module}.`,
        module,
        effectiveStatus: sub.effectiveStatus,
        planId: plan.id,
        planName: plan.name,
      };
    }

    if (sub.effectiveStatus === "PAST_DUE") {
      return {
        allowed: false,
        code: "SUBSCRIPTION_PAST_DUE",
        reason: `Subscription payment is overdue. Settle billing to access ${module}.`,
        module,
        effectiveStatus: sub.effectiveStatus,
        planId: plan.id,
        planName: plan.name,
      };
    }

    if (sub.effectiveStatus === "CANCELLED") {
      return {
        allowed: false,
        code: "SUBSCRIPTION_CANCELLED",
        reason: `Subscription has been cancelled. Access to ${module} is locked.`,
        module,
        effectiveStatus: sub.effectiveStatus,
        planId: plan.id,
        planName: plan.name,
      };
    }
  }

  // 2. Check if the module is included in the plan (All core modules included in all room bands)
  if (!plan.modules.includes(module)) {
    return {
      allowed: false,
      code: "MODULE_NOT_ENTITLED",
      reason: `The ${module} module is not included in the ${plan.name} plan.`,
      module,
      effectiveStatus: sub.effectiveStatus,
      planId: plan.id,
      planName: plan.name,
    };
  }

  return {
    allowed: true,
    effectiveStatus: sub.effectiveStatus,
    planId: plan.id,
    planName: plan.name,
  };
}

/**
 * Checks whether creating additional resources (rooms, staff) would exceed
 * the plan's configured usage limits.
 */
export async function checkUsageLimit(
  hotelId: string,
  limitType: "maxRooms" | "maxStaff",
  increment = 1
): Promise<UsageLimitCheckResult> {
  const sub = await getOrBootstrapSubscription(hotelId);
  const plan = sub.plan;
  const maxLimit = plan.limits[limitType];

  if (!sub.isOperational) {
    const code = sub.effectiveStatus === "TRIAL_EXPIRED" ? "TRIAL_EXPIRED" :
      sub.effectiveStatus === "SUSPENDED" ? "SUBSCRIPTION_SUSPENDED" :
      sub.effectiveStatus === "CANCELLED" ? "SUBSCRIPTION_CANCELLED" :
      "SUBSCRIPTION_PAST_DUE";
    return {
      allowed: false,
      limitType,
      currentCount: 0,
      maxLimit,
      planId: plan.id,
      planName: plan.name,
      code,
      reason: `Subscription is not operational (${sub.effectiveStatus}); ${limitType === "maxRooms" ? "room" : "staff"} changes are blocked.`,
    };
  }

  let currentCount = 0;
  if (limitType === "maxRooms") {
    currentCount = await prisma.room.count({
      where: { hotelId, isActive: true },
    });
  } else if (limitType === "maxStaff") {
    currentCount = await prisma.hotelMembership.count({
      where: { hotelId, status: "ACTIVE" },
    });
  }

  // Check if limit is finite and exceeded
  if (isFinite(maxLimit) && currentCount + increment > maxLimit) {
    const resourceLabel = limitType === "maxRooms" ? "rooms" : "active staff members";
    const nextBand = limitType === "maxRooms" ? getBandForRoomCount(currentCount + increment) : null;
    const bandGuidance = nextBand
      ? ` Adding ${increment} room(s) brings active inventory to ${currentCount + increment}, which requires stepping up to ${nextBand.name}.`
      : "";

    return {
      allowed: false,
      code: "PLAN_LIMIT_EXCEEDED",
      limitType,
      currentCount,
      maxLimit,
      planId: plan.id,
      planName: plan.name,
      recommendedNextBand: nextBand ? nextBand.name : undefined,
      reason: `Plan limit reached: The ${plan.name} allows a maximum of ${maxLimit} ${resourceLabel} (current: ${currentCount}).${bandGuidance}`,
    };
  }

  return {
    allowed: true,
    limitType,
    currentCount,
    maxLimit,
    planId: plan.id,
    planName: plan.name,
  };
}

export type LockedUsageLimitResult<T> =
  | { allowed: true; value: T }
  | { allowed: false; limit: UsageLimitCheckResult };

export class UsageLimitUnavailableError extends Error {
  readonly code = "USAGE_LIMIT_UNAVAILABLE";
  readonly statusCode = 503;

  constructor() {
    super("Resource quota could not be verified safely.");
    this.name = "UsageLimitUnavailableError";
  }
}

/**
 * Serializes quota-sensitive room/staff creation and reactivation with a
 * PostgreSQL transaction-scoped advisory lock. The write callback executes in
 * the same transaction as the count, so cooperating writers cannot race past
 * the capacity check.
 */
export async function withUsageLimitLock<T>(
  hotelId: string,
  limitType: "maxRooms" | "maxStaff",
  increment: number,
  operation: (tx: any) => Promise<T>
): Promise<LockedUsageLimitResult<T>> {
  const sub = await getOrBootstrapSubscription(hotelId);
  const plan = sub.plan;
  const maxLimit = plan.limits[limitType];
  if (!sub.isOperational) {
    const code = sub.effectiveStatus === "TRIAL_EXPIRED" ? "TRIAL_EXPIRED" :
      sub.effectiveStatus === "SUSPENDED" ? "SUBSCRIPTION_SUSPENDED" :
      sub.effectiveStatus === "CANCELLED" ? "SUBSCRIPTION_CANCELLED" :
      "SUBSCRIPTION_PAST_DUE";
    return {
      allowed: false,
      limit: { allowed: false, limitType, currentCount: 0, maxLimit, planId: plan.id, planName: plan.name, code,
        reason: `Subscription is not operational (${sub.effectiveStatus}); ${limitType === "maxRooms" ? "room" : "staff"} changes are blocked.` },
    };
  }

  return prisma.$transaction(async (tx: any) => {
    let currentCount: number;
    try {
      const lockKey = `hotel-${hotelId}-${limitType}-quota`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      currentCount = limitType === "maxRooms"
        ? await tx.room.count({ where: { hotelId, isActive: true } })
        : await tx.hotelMembership.count({ where: { hotelId, status: "ACTIVE" } });
    } catch {
      throw new UsageLimitUnavailableError();
    }
    if (!Number.isInteger(currentCount) || currentCount < 0) throw new UsageLimitUnavailableError();
    if (Number.isFinite(maxLimit) && currentCount + increment > maxLimit) {
      const nextBand = limitType === "maxRooms" ? getBandForRoomCount(currentCount + increment) : null;
      const resourceLabel = limitType === "maxRooms" ? "rooms" : "active staff members";
      return {
        allowed: false as const,
        limit: {
          allowed: false,
          limitType,
          currentCount,
          maxLimit,
          planId: plan.id,
          planName: plan.name,
          recommendedNextBand: nextBand?.name,
          code: "PLAN_LIMIT_EXCEEDED",
          reason: `Plan limit reached: The ${plan.name} allows a maximum of ${maxLimit} ${resourceLabel} (current: ${currentCount}).`,
        },
      };
    }
    return { allowed: true as const, value: await operation(tx) };
  }, { isolationLevel: "Serializable", timeout: 15_000 });
}

/**
 * Detailed billable room breakdown:
 * - Active rooms (billable)
 * - Decommissioned rooms (non-billable)
 * - Temporary closures (out of order, maintenance - billable)
 * - Matching band and capacity status
 */
export async function getBillableRoomBreakdown(hotelId: string): Promise<BillableRoomBreakdown> {
  const rooms: any[] = await (prisma as any).room.findMany({
    where: { hotelId },
    select: { id: true, isActive: true, status: true },
  });

  const totalConfiguredRooms = rooms.length;
  let billableActiveRooms = 0;
  let decommissionedRooms = 0;
  const statusBreakdown = {
    available: 0,
    occupied: 0,
    reserved: 0,
    dirty: 0,
    outOfOrder: 0,
    maintenance: 0,
  };

  for (const r of rooms) {
    if (r.isActive) {
      billableActiveRooms++;
      const s = (r.status || "").toUpperCase();
      if (s === "AVAILABLE") statusBreakdown.available++;
      else if (s === "OCCUPIED") statusBreakdown.occupied++;
      else if (s === "RESERVED") statusBreakdown.reserved++;
      else if (s === "DIRTY") statusBreakdown.dirty++;
      else if (s === "OUT_OF_ORDER") statusBreakdown.outOfOrder++;
      else if (s === "MAINTENANCE") statusBreakdown.maintenance++;
      else statusBreakdown.available++;
    } else {
      decommissionedRooms++;
    }
  }

  const sub = await getOrBootstrapSubscription(hotelId);
  const currentBand = sub.plan;
  const recommendedBand = getBandForRoomCount(billableActiveRooms);
  const isOverBandCapacity =
    isFinite(currentBand.limits.maxRooms) && billableActiveRooms > currentBand.limits.maxRooms;
  const roomsRemainingInBand = isFinite(currentBand.limits.maxRooms)
    ? Math.max(0, currentBand.limits.maxRooms - billableActiveRooms)
    : null;

  return {
    totalConfiguredRooms,
    billableActiveRooms,
    decommissionedRooms,
    statusBreakdown,
    currentBand,
    recommendedBand,
    isOverBandCapacity,
    roomsRemainingInBand,
  };
}

/**
 * Retrieves comprehensive operational usage, room-band pricing calculation,
 * and subscription stats for a hotel.
 */
export async function getHotelUsageAndSubscription(hotelId: string) {
  const sub = await getOrBootstrapSubscription(hotelId);
  const [breakdown, staffCount, reservationCount] = await Promise.all([
    getBillableRoomBreakdown(hotelId),
    prisma.hotelMembership.count({ where: { hotelId, status: "ACTIVE" } }),
    prisma.reservation.count({ where: { hotelId } }),
  ]);

  const pricing = calculateBandPricing({
    roomCount: breakdown.billableActiveRooms,
    billingInterval: sub.billingInterval,
    currency: sub.currency,
  });

  return {
    subscription: sub,
    breakdown,
    pricing,
    usage: {
      rooms: {
        current: breakdown.billableActiveRooms,
        decommissioned: breakdown.decommissionedRooms,
        max: sub.plan.limits.maxRooms,
        isAtLimit: isFinite(sub.plan.limits.maxRooms) && breakdown.billableActiveRooms >= sub.plan.limits.maxRooms,
        isOverLimit: breakdown.isOverBandCapacity,
      },
      staff: {
        current: staffCount,
        max: sub.plan.limits.maxStaff,
        isAtLimit: isFinite(sub.plan.limits.maxStaff) && staffCount >= sub.plan.limits.maxStaff,
      },
      reservations: {
        total: reservationCount,
      },
    },
  };
}
