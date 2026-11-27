import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
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
  | "RESTRICTED"
  | "READ_ONLY"
  | "SUSPENDED"
  | "CANCELLED";

export const PAST_DUE_GRACE_PERIOD_DAYS = 7;
export const PAST_DUE_LOCKED_END_DAY = 14;
export const RESTRICTED_END_DAY = 21;
export const READ_ONLY_END_DAY = 35;

export const TRIAL_EXPIRED_WINDOW_DAYS = 7;
export const TRIAL_RESTRICTED_END_DAY = 14;
export const TRIAL_READ_ONLY_END_DAY = 28;

export interface SubscriptionLifecycleSummary {
  stage: EvaluatedSubscriptionState;
  accessMode: "FULL" | "GRACE" | "READ_ONLY" | "BILLING_EXPORT_ONLY";
  canReadOperations: boolean;
  canWriteOperations: boolean;
  canExportRecords: boolean;
  canRecoverBilling: boolean;
  overdueDays: number;
  nextStage: EvaluatedSubscriptionState | null;
  daysUntilNextStage: number | null;
  nextTransitionAt: string | null;
  summaryMessage: string;
  recoverySteps: string[];
}

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

const MS_PER_DAY = 86_400_000;

function evaluatePaidOverdueDays(end: Date, now: Date): {
  effectiveStatus: EvaluatedSubscriptionState;
  isOperational: boolean;
  isOverdue: boolean;
  daysRemaining: number;
} {
  const overdueMs = now.getTime() - end.getTime();
  if (overdueMs <= PAST_DUE_GRACE_PERIOD_DAYS * MS_PER_DAY) {
    return {
      effectiveStatus: "PAST_DUE",
      isOperational: true,
      isOverdue: true,
      daysRemaining: Math.max(0, Math.ceil((end.getTime() + PAST_DUE_GRACE_PERIOD_DAYS * MS_PER_DAY - now.getTime()) / MS_PER_DAY)),
    };
  }
  if (overdueMs <= PAST_DUE_LOCKED_END_DAY * MS_PER_DAY) {
    return { effectiveStatus: "PAST_DUE", isOperational: false, isOverdue: true, daysRemaining: 0 };
  }
  if (overdueMs <= RESTRICTED_END_DAY * MS_PER_DAY) {
    return { effectiveStatus: "RESTRICTED", isOperational: false, isOverdue: true, daysRemaining: 0 };
  }
  if (overdueMs <= READ_ONLY_END_DAY * MS_PER_DAY) {
    return { effectiveStatus: "READ_ONLY", isOperational: false, isOverdue: true, daysRemaining: 0 };
  }
  return { effectiveStatus: "SUSPENDED", isOperational: false, isOverdue: true, daysRemaining: 0 };
}

/**
 * Evaluates server-authoritative subscription dates across the complete
 * lifecycle: trial -> active -> past due -> restricted -> read-only -> suspended -> cancelled.
 * Past-due accounts retain operational access only until the configured grace
 * deadline; missing or malformed state fails closed.
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
  if (sub.status === SubscriptionStatus.RESTRICTED) {
    if (sub.currentPeriodEndsAt && now.getTime() - new Date(sub.currentPeriodEndsAt).getTime() > RESTRICT_TO_READ_ONLY_MS()) {
      const overdueMs = now.getTime() - new Date(sub.currentPeriodEndsAt).getTime();
      if (overdueMs > READ_ONLY_END_DAY * MS_PER_DAY) {
        return { effectiveStatus: "SUSPENDED", isOperational: false, isOverdue: true, daysRemaining: 0 };
      }
      if (overdueMs > RESTRICTED_END_DAY * MS_PER_DAY) {
        return { effectiveStatus: "READ_ONLY", isOperational: false, isOverdue: true, daysRemaining: 0 };
      }
    }
    return { effectiveStatus: "RESTRICTED", isOperational: false, isOverdue: true, daysRemaining: 0 };
  }
  if (sub.status === SubscriptionStatus.READ_ONLY) {
    if (sub.currentPeriodEndsAt) {
      const overdueMs = now.getTime() - new Date(sub.currentPeriodEndsAt).getTime();
      if (overdueMs > READ_ONLY_END_DAY * MS_PER_DAY) {
        return { effectiveStatus: "SUSPENDED", isOperational: false, isOverdue: true, daysRemaining: 0 };
      }
    }
    return { effectiveStatus: "READ_ONLY", isOperational: false, isOverdue: true, daysRemaining: 0 };
  }
  if (sub.status === SubscriptionStatus.TRIALING) {
    if (!sub.trialEndsAt) {
      throw new SubscriptionStatusUnavailableError("Trial expiry is missing.");
    }
    const end = new Date(sub.trialEndsAt);
    if (now > end) {
      const overdueMs = now.getTime() - end.getTime();
      if (overdueMs <= TRIAL_EXPIRED_WINDOW_DAYS * MS_PER_DAY) {
        return { effectiveStatus: "TRIAL_EXPIRED", isOperational: false, isOverdue: true, daysRemaining: 0 };
      }
      if (overdueMs <= TRIAL_RESTRICTED_END_DAY * MS_PER_DAY) {
        return { effectiveStatus: "RESTRICTED", isOperational: false, isOverdue: true, daysRemaining: 0 };
      }
      if (overdueMs <= TRIAL_READ_ONLY_END_DAY * MS_PER_DAY) {
        return { effectiveStatus: "READ_ONLY", isOperational: false, isOverdue: true, daysRemaining: 0 };
      }
      return { effectiveStatus: "SUSPENDED", isOperational: false, isOverdue: true, daysRemaining: 0 };
    }
    return {
      effectiveStatus: "TRIALING",
      isOperational: true,
      isOverdue: false,
      daysRemaining: Math.max(0, Math.ceil((end.getTime() - now.getTime()) / MS_PER_DAY)),
    };
  }
  if (sub.status === SubscriptionStatus.PAST_DUE) {
    if (!sub.currentPeriodEndsAt) {
      throw new SubscriptionStatusUnavailableError("Past-due subscription period end is missing.");
    }
    return evaluatePaidOverdueDays(new Date(sub.currentPeriodEndsAt), now);
  }
  if (sub.status === SubscriptionStatus.ACTIVE) {
    if (!sub.currentPeriodEndsAt) {
      throw new SubscriptionStatusUnavailableError("Active subscription period end is missing.");
    }
    const end = new Date(sub.currentPeriodEndsAt);
    if (now > end) {
      return evaluatePaidOverdueDays(end, now);
    }
    return {
      effectiveStatus: "ACTIVE",
      isOperational: true,
      isOverdue: false,
      daysRemaining: Math.max(0, Math.ceil((end.getTime() - now.getTime()) / MS_PER_DAY)),
    };
  }

  throw new SubscriptionStatusUnavailableError("Subscription status is unrecognized.");
}

function RESTRICT_TO_READ_ONLY_MS() {
  return RESTRICTED_END_DAY * MS_PER_DAY;
}

export function getSubscriptionLifecycleSummary(
  sub: {
    storedStatus: SubscriptionStatus;
    effectiveStatus: EvaluatedSubscriptionState;
    isOperational: boolean;
    trialEndsAt: Date | null;
    currentPeriodEndsAt: Date | null;
    suspensionReason: string | null;
  },
  now = new Date()
): SubscriptionLifecycleSummary {
  const stage = sub.effectiveStatus;
  const anchorEnd =
    sub.storedStatus === SubscriptionStatus.TRIALING
      ? sub.trialEndsAt
      : sub.currentPeriodEndsAt;
  const overdueDays =
    anchorEnd && now > anchorEnd
      ? Math.max(0, Math.floor((now.getTime() - anchorEnd.getTime()) / MS_PER_DAY))
      : 0;

  let nextStage: EvaluatedSubscriptionState | null = null;
  let nextTransitionAt: string | null = null;
  let daysUntilNextStage: number | null = null;

  if (anchorEnd) {
    const isTrialTrack = sub.storedStatus === SubscriptionStatus.TRIALING;
    let targetDayOffset: number | null = null;
    if (stage === "TRIALING") {
      nextStage = "TRIAL_EXPIRED";
      targetDayOffset = 0;
    } else if (stage === "ACTIVE") {
      nextStage = "PAST_DUE";
      targetDayOffset = 0;
    } else if (stage === "TRIAL_EXPIRED") {
      nextStage = "RESTRICTED";
      targetDayOffset = TRIAL_EXPIRED_WINDOW_DAYS;
    } else if (stage === "PAST_DUE") {
      nextStage = sub.isOperational ? "PAST_DUE" : "RESTRICTED";
      targetDayOffset = sub.isOperational ? PAST_DUE_GRACE_PERIOD_DAYS : PAST_DUE_LOCKED_END_DAY;
    } else if (stage === "RESTRICTED") {
      nextStage = "READ_ONLY";
      targetDayOffset = isTrialTrack ? TRIAL_RESTRICTED_END_DAY : RESTRICTED_END_DAY;
    } else if (stage === "READ_ONLY") {
      nextStage = "SUSPENDED";
      targetDayOffset = isTrialTrack ? TRIAL_READ_ONLY_END_DAY : READ_ONLY_END_DAY;
    }

    if (targetDayOffset !== null) {
      const targetDate = new Date(anchorEnd.getTime() + targetDayOffset * MS_PER_DAY);
      if (targetDate > now) {
        nextTransitionAt = targetDate.toISOString();
        daysUntilNextStage = Math.max(0, Math.ceil((targetDate.getTime() - now.getTime()) / MS_PER_DAY));
      } else {
        nextStage = null;
      }
    }
  }

  const recoverySteps = [
    "Confirm your exact renewal amount and billing currency with Platform Billing Support.",
    "Settle via M-Pesa Paybill 400200 or Co-op Bank account 01102662965002 using your Hotel ID or name as the reference.",
    "Share your transaction reference code with Platform Billing Support for manual verification and immediate reactivation.",
    "Export a JSON, Excel (.xlsx), or PDF backup of your property records at any time from Billing & Recovery.",
  ];

  if (stage === "ACTIVE") {
    return {
      stage,
      accessMode: "FULL",
      canReadOperations: true,
      canWriteOperations: true,
      canExportRecords: true,
      canRecoverBilling: true,
      overdueDays: 0,
      nextStage,
      daysUntilNextStage,
      nextTransitionAt,
      summaryMessage: "Your workspace is active with full read and write access across all modules.",
      recoverySteps,
    };
  }

  if (stage === "TRIALING") {
    return {
      stage,
      accessMode: "FULL",
      canReadOperations: true,
      canWriteOperations: true,
      canExportRecords: true,
      canRecoverBilling: true,
      overdueDays: 0,
      nextStage,
      daysUntilNextStage,
      nextTransitionAt,
      summaryMessage: "Your free trial is active with full access. Verify a manual payment before trial expiry to continue uninterrupted.",
      recoverySteps,
    };
  }

  if (stage === "PAST_DUE" && sub.isOperational) {
    return {
      stage,
      accessMode: "GRACE",
      canReadOperations: true,
      canWriteOperations: true,
      canExportRecords: true,
      canRecoverBilling: true,
      overdueDays,
      nextStage,
      daysUntilNextStage,
      nextTransitionAt,
      summaryMessage: "Your billing period has ended and you are in the grace window. Renew manually before the grace period expires to avoid read-only restrictions.",
      recoverySteps,
    };
  }

  if (stage === "TRIAL_EXPIRED" || stage === "PAST_DUE" || stage === "RESTRICTED" || stage === "READ_ONLY") {
    const label =
      stage === "TRIAL_EXPIRED"
        ? "Trial ended — write mutations are disabled"
        : stage === "PAST_DUE"
        ? "Grace period ended — write mutations are disabled"
        : stage === "RESTRICTED"
        ? "Account restricted — new operational changes are blocked"
        : "Account in read-only mode — operational records are view-and-export only";

    return {
      stage,
      accessMode: "READ_ONLY",
      canReadOperations: true,
      canWriteOperations: false,
      canExportRecords: true,
      canRecoverBilling: true,
      overdueDays,
      nextStage,
      daysUntilNextStage,
      nextTransitionAt,
      summaryMessage: `${label}. You can still view operational data and export full workspace backups while renewing your subscription.`,
      recoverySteps,
    };
  }

  const reasonSuffix = sub.suspensionReason ? ` Reason: ${sub.suspensionReason}.` : "";
  return {
    stage,
    accessMode: "BILLING_EXPORT_ONLY",
    canReadOperations: false,
    canWriteOperations: false,
    canExportRecords: true,
    canRecoverBilling: true,
    overdueDays,
    nextStage: null,
    daysUntilNextStage: null,
    nextTransitionAt: null,
    summaryMessage:
      stage === "CANCELLED"
        ? `Your subscription has been cancelled.${reasonSuffix} Operational access is disabled, but owners and admins can still view billing history and export property records.`
        : `Your workspace is suspended.${reasonSuffix} Operational access is disabled, but owners and admins can still review invoices, export property records, and reactivate via manual payment verification.`,
    recoverySteps,
  };
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

  let hotel: any;
  try {
    hotel = await prisma.hotel.findUnique({ where: { id: hotelId }, select: { id: true, status: true, createdAt: true, currency: true } });
  } catch { throw new SubscriptionStatusUnavailableError("Hotel lifecycle status is unavailable."); }
  if (!hotel) throw new SubscriptionStatusUnavailableError("Hotel not found.");

  if (!sub) {
    let activeRoomsCount: number;
    try {
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
  let evaluation = evaluateSubscriptionStatus({
    status: sub.status,
    trialEndsAt: sub.trialEndsAt,
    currentPeriodEndsAt: sub.currentPeriodEndsAt,
  });
  // During legacy divergence, the more restrictive hotel lifecycle wins; never
  // let a live subscription bypass a hotel suspension or cancellation.
  if (hotel.status === HotelStatus.SUSPENDED || hotel.status === HotelStatus.CANCELLED) {
    evaluation = { effectiveStatus: hotel.status, isOperational: false, isOverdue: false, daysRemaining: null };
  } else if (hotel.status === HotelStatus.TRIALING && (sub.status === SubscriptionStatus.ACTIVE || sub.status === SubscriptionStatus.PAST_DUE)) {
    const trial = evaluateSubscriptionStatus({ status: SubscriptionStatus.TRIALING, trialEndsAt: sub.trialEndsAt });
    if (!trial.isOperational || (sub.status === SubscriptionStatus.ACTIVE && evaluation.isOperational)) evaluation = trial;
  }
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
  module: SaaSModule,
  access: "read" | "write" = "write"
): Promise<EntitlementCheckResult> {
  const sub = await getOrBootstrapSubscription(hotelId);
  const plan = sub.plan;

  // 1. Check subscription operational status
  const readOnlyExpired =
    access === "read" &&
    (sub.effectiveStatus === "TRIAL_EXPIRED" ||
      sub.effectiveStatus === "PAST_DUE" ||
      sub.effectiveStatus === "RESTRICTED" ||
      sub.effectiveStatus === "READ_ONLY");
  if (!sub.isOperational && !readOnlyExpired) {
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
        reason: `Your trial has ended. Please activate your subscription to access ${module}.`,
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

    if (sub.effectiveStatus === "RESTRICTED") {
      return {
        allowed: false,
        code: "SUBSCRIPTION_RESTRICTED",
        reason: `Subscription is restricted due to overdue billing. Settle billing to modify ${module}.`,
        module,
        effectiveStatus: sub.effectiveStatus,
        planId: plan.id,
        planName: plan.name,
      };
    }

    if (sub.effectiveStatus === "READ_ONLY") {
      return {
        allowed: false,
        code: "SUBSCRIPTION_READ_ONLY",
        reason: `Subscription is in read-only mode. Settle billing to modify ${module}.`,
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

function mapNonOperationalCode(effectiveStatus: EvaluatedSubscriptionState): string {
  switch (effectiveStatus) {
    case "TRIAL_EXPIRED":
      return "TRIAL_EXPIRED";
    case "RESTRICTED":
      return "SUBSCRIPTION_RESTRICTED";
    case "READ_ONLY":
      return "SUBSCRIPTION_READ_ONLY";
    case "SUSPENDED":
      return "SUBSCRIPTION_SUSPENDED";
    case "CANCELLED":
      return "SUBSCRIPTION_CANCELLED";
    default:
      return "SUBSCRIPTION_PAST_DUE";
  }
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
    return {
      allowed: false,
      limitType,
      currentCount: 0,
      maxLimit,
      planId: plan.id,
      planName: plan.name,
      code: mapNonOperationalCode(sub.effectiveStatus),
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
  operation: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<LockedUsageLimitResult<T>> {
  const sub = await getOrBootstrapSubscription(hotelId);
  const plan = sub.plan;
  const maxLimit = plan.limits[limitType];
  if (!sub.isOperational) {
    return {
      allowed: false,
      limit: { allowed: false, limitType, currentCount: 0, maxLimit, planId: plan.id, planName: plan.name, code: mapNonOperationalCode(sub.effectiveStatus),
        reason: `Subscription is not operational (${sub.effectiveStatus}); ${limitType === "maxRooms" ? "room" : "staff"} changes are blocked.` },
    };
  }

  return prisma.$transaction<LockedUsageLimitResult<T>>(async (tx) => {
    let currentCount: number;
    try {
      const lockKey = `hotel-${hotelId}-${limitType}-quota`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked`;
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
