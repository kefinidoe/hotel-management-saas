import { NextResponse } from "next/server";
import { getPlatformAdminFromRoute } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  getPlan,
  SUBSCRIPTION_PLANS,
  isPlanAvailableForNewSub,
  SubscriptionStatus,
  BillingInterval,
} from "@/lib/plans";
import {
  evaluateSubscriptionStatus,
  getOrBootstrapSubscription,
  getHotelUsageAndSubscription,
} from "@/lib/entitlements";
import { PlatformRole } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getPlatformAdminFromRoute();
  if (admin instanceof Response || (admin && "status" in admin)) return admin as any;

  const { id: hotelId } = await params;

  try {
    const hotel = await prisma.hotel.findUnique({
      where: { id: hotelId },
      include: {
        subscription: true,
      },
    });

    if (!hotel) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "Hotel not found." },
        { status: 404 }
      );
    }

    const usageDetails = await getHotelUsageAndSubscription(hotelId);

    // Fetch recent administrative logs for this hotel's subscription
    const auditLogs = await prisma.auditLog.findMany({
      where: {
        hotelId,
        entity: "Subscription",
      },
      include: {
        user: { select: { name: true, email: true, platformRole: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return NextResponse.json({
      hotel: {
        id: hotel.id,
        name: hotel.name,
        slug: hotel.slug,
        status: hotel.status,
        currency: hotel.currency,
      },
      subscription: usageDetails.subscription,
      usage: usageDetails.usage,
      auditLogs: auditLogs.map((l) => ({
        id: l.id,
        action: l.action,
        actorName: l.user?.name || "System",
        actorEmail: l.user?.email || null,
        actorPlatformRole: l.user?.platformRole || null,
        metadata: l.metadata,
        createdAt: l.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("Failed to fetch hotel subscription details:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "Failed to load hotel subscription." },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getPlatformAdminFromRoute([
    PlatformRole.PLATFORM_SUPER_ADMIN,
    PlatformRole.PLATFORM_BILLING,
    PlatformRole.PLATFORM_SUPPORT,
  ]);
  if (admin instanceof Response || (admin && "status" in admin)) return admin as any;

  const { id: hotelId } = await params;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "INVALID_REQUEST_BODY", message: "Malformed JSON body." },
      { status: 400 }
    );
  }

  const {
    action, // "CHANGE_PLAN" | "EXTEND_TRIAL" | "CHANGE_STATUS" | "ADJUST_BILLING"
    planId,
    newStatus,
    extendDays,
    billingInterval,
    reason,
    confirmed,
  } = body;

  // 1. Mandatory Reason Check for Administrative Accountability
  if (!reason || typeof reason !== "string" || reason.trim().length < 5) {
    return NextResponse.json(
      {
        error: "REASON_REQUIRED",
        message: "An operational reason of at least 5 characters is required for administrative subscription adjustments.",
      },
      { status: 400 }
    );
  }

  try {
    // 2. Ensure hotel and subscription exist
    const subContext = await getOrBootstrapSubscription(hotelId);

    const currentSub = await prisma.subscription.findUnique({
      where: { hotelId },
    });
    if (!currentSub) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "Subscription record not found." },
        { status: 404 }
      );
    }

    let updateData: any = {};
    let auditAction = "PLATFORM_SUBSCRIPTION_UPDATED";
    let auditDetails: Record<string, any> = {
      adminUserId: admin.userId,
      adminRole: admin.platformRole,
      reason: reason.trim(),
    };

    if (action === "CHANGE_PLAN" || action === "CHANGE_BAND") {
      if (!planId || typeof planId !== "string") {
        return NextResponse.json(
          { error: "INVALID_PLAN_ID", message: "A valid planId or room band ID must be specified." },
          { status: 400 }
        );
      }

      const targetPlan = SUBSCRIPTION_PLANS[planId.toUpperCase()];
      if (!targetPlan) {
        return NextResponse.json(
          { error: "INVALID_PLAN", message: `Room band or plan '${planId}' does not exist.` },
          { status: 400 }
        );
      }

      // If switching to an inactive tier (e.g. legacy), only PLATFORM_SUPER_ADMIN can authorize
      if (!targetPlan.isActive && admin.platformRole !== PlatformRole.PLATFORM_SUPER_ADMIN) {
        return NextResponse.json(
          {
            error: "UNAUTHORIZED_TIER",
            message: "Only PLATFORM_SUPER_ADMIN can assign retired or grandfathered plans.",
          },
          { status: 403 }
        );
      }

      const previousPlanId = currentSub.planId;
      if (previousPlanId === targetPlan.id) {
        return NextResponse.json(
          { error: "ALREADY_ASSIGNED", message: `Hotel is already on room band '${targetPlan.name}'.` },
          { status: 400 }
        );
      }

      const isUSD = (currentSub.currency || "KES").toUpperCase() === "USD";
      updateData.planId = targetPlan.id;
      updateData.amount =
        currentSub.billingInterval === BillingInterval.YEARLY
          ? (isUSD ? targetPlan.yearlyPriceUSD : targetPlan.yearlyPriceKES)
          : (isUSD ? targetPlan.monthlyPriceUSD : targetPlan.monthlyPriceKES);

      updateData.metadata = {
        ...(typeof currentSub.metadata === "object" && currentSub.metadata ? (currentSub.metadata as any) : {}),
        lastBandAdjustment: {
          previousPlan: previousPlanId,
          newPlan: targetPlan.id,
          bandName: targetPlan.name,
          adjustedAt: new Date().toISOString(),
          adminUserId: admin.userId,
          reason: reason.trim(),
        },
      };

      auditAction = "PLATFORM_PLAN_CHANGED";
      auditDetails.previousPlan = previousPlanId;
      auditDetails.newPlan = targetPlan.id;
      auditDetails.planName = targetPlan.name;
    } else if (action === "EXTEND_TRIAL") {
      const days = Number(extendDays);
      if (!days || isNaN(days) || days <= 0 || days > 90) {
        return NextResponse.json(
          { error: "INVALID_EXTENSION_DAYS", message: "Trial extension must be between 1 and 90 days." },
          { status: 400 }
        );
      }

      const currentTrialEnd = currentSub.trialEndsAt ? new Date(currentSub.trialEndsAt) : new Date();
      // If trial has already ended, extend from today; otherwise extend from existing end date
      const baseDate = currentTrialEnd > new Date() ? currentTrialEnd : new Date();
      const newTrialEnd = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);

      updateData.trialEndsAt = newTrialEnd;
      updateData.status = SubscriptionStatus.TRIALING;

      auditAction = "PLATFORM_TRIAL_EXTENDED";
      auditDetails.previousTrialEnd = currentSub.trialEndsAt?.toISOString() || null;
      auditDetails.newTrialEnd = newTrialEnd.toISOString();
      auditDetails.daysExtended = days;
    } else if (action === "CHANGE_STATUS") {
      if (!newStatus || !Object.values(SubscriptionStatus).includes(newStatus as SubscriptionStatus)) {
        return NextResponse.json(
          { error: "INVALID_STATUS", message: "Invalid subscription status." },
          { status: 400 }
        );
      }

      // Explicit confirmation required for destructive / suspension actions
      if (
        (newStatus === SubscriptionStatus.SUSPENDED || newStatus === SubscriptionStatus.CANCELLED) &&
        confirmed !== true
      ) {
        return NextResponse.json(
          {
            error: "CONFIRMATION_REQUIRED",
            message: "Explicit confirmation (confirmed: true) is required to suspend or cancel a subscription.",
          },
          { status: 400 }
        );
      }

      // Check current vs new
      if (currentSub.status === newStatus) {
        return NextResponse.json(
          { error: "ALREADY_IN_STATUS", message: `Subscription is already in status '${newStatus}'.` },
          { status: 400 }
        );
      }

      updateData.status = newStatus;

      if (newStatus === SubscriptionStatus.SUSPENDED) {
        updateData.suspendedAt = new Date();
        updateData.suspensionReason = reason.trim();
      } else if (newStatus === SubscriptionStatus.CANCELLED) {
        updateData.canceledAt = new Date();
      } else if (newStatus === SubscriptionStatus.ACTIVE) {
        updateData.suspendedAt = null;
        updateData.suspensionReason = null;
        // If activating, set current period to 30 days from now if not already set
        const now = new Date();
        updateData.currentPeriodStartsAt = now;
        updateData.currentPeriodEndsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      }

      auditAction = "PLATFORM_SUBSCRIPTION_STATUS_CHANGED";
      auditDetails.previousStatus = currentSub.status;
      auditDetails.newStatus = newStatus;
    } else if (action === "ADJUST_BILLING") {
      if (billingInterval && Object.values(BillingInterval).includes(billingInterval as BillingInterval)) {
        updateData.billingInterval = billingInterval;
        const plan = getPlan(currentSub.planId);
        updateData.amount =
          billingInterval === BillingInterval.YEARLY ? plan.yearlyPriceKES : plan.monthlyPriceKES;
        auditDetails.billingInterval = billingInterval;
      }
      auditAction = "PLATFORM_BILLING_INTERVAL_ADJUSTED";
    } else {
      return NextResponse.json(
        { error: "INVALID_ACTION", message: "Supported actions: CHANGE_PLAN, EXTEND_TRIAL, CHANGE_STATUS, ADJUST_BILLING." },
        { status: 400 }
      );
    }

    // 3. Atomically apply update and write audit log
    const updatedSub = await prisma.$transaction(async (tx) => {
      const updated = await tx.subscription.update({
        where: { hotelId },
        data: updateData,
      });

      await tx.auditLog.create({
        data: {
          hotelId,
          userId: admin.userId,
          action: auditAction,
          entity: "Subscription",
          entityId: updated.id,
          metadata: auditDetails,
        },
      });

      return updated;
    });

    const evaluated = evaluateSubscriptionStatus({
      status: updatedSub.status,
      trialEndsAt: updatedSub.trialEndsAt,
      currentPeriodEndsAt: updatedSub.currentPeriodEndsAt,
    });

    return NextResponse.json({
      success: true,
      subscription: {
        id: updatedSub.id,
        hotelId: updatedSub.hotelId,
        planId: updatedSub.planId,
        planName: getPlan(updatedSub.planId).name,
        storedStatus: updatedSub.status,
        effectiveStatus: evaluated.effectiveStatus,
        isOperational: evaluated.isOperational,
        trialStartsAt: updatedSub.trialStartsAt.toISOString(),
        trialEndsAt: updatedSub.trialEndsAt ? updatedSub.trialEndsAt.toISOString() : null,
        currentPeriodStartsAt: updatedSub.currentPeriodStartsAt.toISOString(),
        currentPeriodEndsAt: updatedSub.currentPeriodEndsAt ? updatedSub.currentPeriodEndsAt.toISOString() : null,
        daysRemaining: evaluated.daysRemaining,
        billingInterval: updatedSub.billingInterval,
        amount: Number(updatedSub.amount),
        suspensionReason: updatedSub.suspensionReason,
      },
    });
  } catch (error) {
    console.error("Failed to update hotel subscription:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "Failed to update subscription." },
      { status: 500 }
    );
  }
}
