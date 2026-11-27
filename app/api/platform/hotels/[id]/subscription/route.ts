import { NextResponse } from "next/server";
import { getPlatformAdminFromRoute } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  getPlan,
  SUBSCRIPTION_PLANS,
  priceForSubscription,
  SubscriptionStatus,
  BillingInterval,
} from "@/lib/plans";
import {
  evaluateSubscriptionStatus,
  getHotelUsageAndSubscription,
} from "@/lib/entitlements";
import { PlatformRole, Prisma } from "@prisma/client";
import { z } from "zod";
import { hasMaxDecimalPlaces } from "@/lib/billing";
import { manualSubscriptionPaymentSchema } from "@/lib/manual-subscription-payment";
import { activateManualSubscription, ManualPaymentConflictError, ManualSubscriptionNotFoundError, ManualActivationForbiddenError } from "@/lib/activate-manual-subscription";
import { hotelStatusForSubscription } from "@/lib/platform-lifecycle";
import { getBillingHistoryForHotel, issueSubscriptionInvoice } from "@/lib/subscription-invoices";

class LifecycleChangedError extends Error {}
class LifecycleForbiddenError extends Error {}
class LifecycleAlreadySetError extends Error {}

export const dynamic = "force-dynamic";

const issueInvoiceSchema = z.strictObject({
  action: z.literal("ISSUE_INVOICE"),
  amount: z
    .number()
    .finite()
    .nonnegative()
    .max(99_999_999.99)
    .refine((v) => hasMaxDecimalPlaces(v, 2), "Amount must have at most two decimal places.")
    .optional(),
  taxAmount: z
    .number()
    .finite()
    .nonnegative()
    .max(99_999_999.99)
    .refine((v) => hasMaxDecimalPlaces(v, 2), "Tax amount must have at most two decimal places.")
    .optional(),
  dueDays: z.number().int().positive().max(365).optional(),
  periodDays: z.number().int().positive().max(3650).optional(),
  reason: z.string().trim().min(5).max(1000),
});

const voidInvoiceSchema = z.strictObject({
  action: z.literal("MARK_INVOICE_VOID"),
  invoiceId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(5).max(1000),
});

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
    const invoices = await getBillingHistoryForHotel(hotelId, {
      id: usageDetails.subscription.id,
      planId: usageDetails.subscription.planId,
      planName: usageDetails.subscription.plan.name,
      billingInterval: usageDetails.subscription.billingInterval,
      currency: usageDetails.subscription.currency,
      metadata: hotel.subscription?.metadata ?? null,
    });

    // Fetch recent administrative logs for this hotel's subscription
    const auditLogs = await prisma.auditLog.findMany({
      where: {
        hotelId,
        entity: { in: ["Subscription", "SubscriptionInvoice"] },
      },
      include: {
        user: { select: { name: true, email: true, platformRole: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 25,
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
      invoices,
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

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "INVALID_REQUEST_BODY", message: "Expected a JSON object." }, { status: 400 });
  }

  if (body.action === "ACTIVATE_MANUAL_PAYMENT") {
    const query = z.strictObject({}).safeParse(Object.fromEntries(new URL(req.url).searchParams));
    const id = z.string().trim().min(1).max(200).safeParse(hotelId);
    const parsed = manualSubscriptionPaymentSchema.safeParse(body);
    if (!query.success || !id.success || !parsed.success) {
      return NextResponse.json({ error: "INVALID_REQUEST", issues: [
        ...(!query.success ? query.error.issues : []),
        ...(!id.success ? id.error.issues.map((issue) => ({ ...issue, path: ["id", ...issue.path] })) : []),
        ...(!parsed.success ? parsed.error.issues : []),
      ] }, { status: 400 });
    }
    try {
      const updated = await activateManualSubscription(id.data, admin, parsed.data);
      return NextResponse.json({
        success: true,
        invoiceId: updated.invoiceId,
        invoiceNumber: updated.invoiceNumber,
        subscription: {
          id: updated.id,
          hotelId: updated.hotelId,
          status: updated.status,
          currentPeriodStartsAt: updated.currentPeriodStartsAt.toISOString(),
          currentPeriodEndsAt: updated.currentPeriodEndsAt?.toISOString() ?? null,
        },
      });
    } catch (error) {
      if (error instanceof ManualPaymentConflictError || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
        return NextResponse.json({ error: "DUPLICATE_PAYMENT_REFERENCE", message: "This payment reference has already been recorded." }, { status: 409 });
      }
      if (error instanceof ManualSubscriptionNotFoundError) return NextResponse.json({ error: "NOT_FOUND", message: error.message }, { status: 404 });
      if (error instanceof ManualActivationForbiddenError) return NextResponse.json({ error: "FORBIDDEN", message: error.message }, { status: 403 });
      console.error("Failed to activate manual subscription payment:", error);
      return NextResponse.json({ error: "SERVER_ERROR", message: "Failed to record manual payment." }, { status: 500 });
    }
  }

  if (body.action === "ISSUE_INVOICE") {
    const id = z.string().trim().min(1).max(200).safeParse(hotelId);
    const parsed = issueInvoiceSchema.safeParse(body);
    if (!id.success || !parsed.success) {
      return NextResponse.json(
        {
          error: "INVALID_REQUEST",
          message: "Valid invoice amount, due days, and reason (min 5 chars) are required.",
          issues: [
            ...(!id.success ? id.error.issues : []),
            ...(!parsed.success ? parsed.error.issues : []),
          ],
        },
        { status: 400 }
      );
    }

    try {
      const existingSub = await prisma.subscription.findUnique({
        where: { hotelId: id.data },
        select: { id: true },
      });
      if (!existingSub) {
        return NextResponse.json(
          { error: "NOT_FOUND", message: "Subscription record not found." },
          { status: 404 }
        );
      }
      const invoice = await issueSubscriptionInvoice({
        hotelId: id.data,
        adminUserId: admin.userId,
        adminRole: admin.platformRole,
        amount: parsed.data.amount,
        taxAmount: parsed.data.taxAmount,
        dueDays: parsed.data.dueDays,
        periodDays: parsed.data.periodDays,
        notes: parsed.data.reason,
      });
      return NextResponse.json({ success: true, invoice });
    } catch (error) {
      console.error("Failed to issue subscription invoice:", error);
      return NextResponse.json(
        { error: "SERVER_ERROR", message: "Failed to issue subscription invoice." },
        { status: 500 }
      );
    }
  }

  if (body.action === "MARK_INVOICE_VOID") {
    const parsed = voidInvoiceSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "INVALID_REQUEST",
          message: "invoiceId and reason (min 5 chars) are required.",
          issues: parsed.error.issues,
        },
        { status: 400 }
      );
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        const existing = await tx.subscriptionInvoice.findFirst({
          where: { id: parsed.data.invoiceId, hotelId },
        });
        if (!existing) {
          throw new Error("INVOICE_NOT_FOUND");
        }
        if (existing.status === "PAID") {
          throw new Error("INVOICE_ALREADY_PAID");
        }
        if (existing.status === "VOID") {
          throw new Error("INVOICE_ALREADY_VOID");
        }

        const voided = await tx.subscriptionInvoice.update({
          where: { id: existing.id },
          data: {
            status: "VOID",
            notes: `${existing.notes ? `${existing.notes} | ` : ""}Voided: ${parsed.data.reason}`,
          },
        });

        await tx.auditLog.create({
          data: {
            hotelId,
            userId: admin.userId,
            action: "PLATFORM_SUBSCRIPTION_INVOICE_VOIDED",
            entity: "SubscriptionInvoice",
            entityId: existing.id,
            metadata: {
              invoiceNumber: existing.invoiceNumber,
              reason: parsed.data.reason,
              adminRole: admin.platformRole,
            },
          },
        });

        return voided;
      });

      return NextResponse.json({
        success: true,
        invoice: { id: updated.id, invoiceNumber: updated.invoiceNumber, status: updated.status },
      });
    } catch (error: any) {
      if (error?.message === "INVOICE_NOT_FOUND") {
        return NextResponse.json({ error: "NOT_FOUND", message: "Invoice not found for this hotel." }, { status: 404 });
      }
      if (error?.message === "INVOICE_ALREADY_PAID") {
        return NextResponse.json({ error: "INVOICE_ALREADY_PAID", message: "Paid invoices cannot be voided." }, { status: 409 });
      }
      if (error?.message === "INVOICE_ALREADY_VOID") {
        return NextResponse.json({ error: "ALREADY_VOID", message: "Invoice is already void." }, { status: 400 });
      }
      console.error("Failed to void subscription invoice:", error);
      return NextResponse.json({ error: "SERVER_ERROR", message: "Failed to void invoice." }, { status: 500 });
    }
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
    // Existing subscriptions only: never create an unaudited row before a lifecycle transaction.
    const [currentSub, currentHotel] = await Promise.all([
      prisma.subscription.findUnique({ where: { hotelId } }),
      prisma.hotel.findUnique({ where: { id: hotelId }, select: { status: true, currency: true } }),
    ]);
    if (!currentSub || !currentHotel) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "Subscription record not found." },
        { status: 404 }
      );
    }

    let updateData: any = {};
    let auditAction = "PLATFORM_SUBSCRIPTION_UPDATED";
    const auditDetails: Record<string, any> = {
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

      const resolvedPrice = priceForSubscription({
        planId: targetPlan.id,
        billingInterval: currentSub.billingInterval as BillingInterval,
        currency: currentSub.currency || currentHotel.currency,
      });
      updateData.planId = targetPlan.id;
      updateData.amount = resolvedPrice ?? (targetPlan.isCustomQuote ? 0 : currentSub.amount);

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
      updateData.suspendedAt = null;
      updateData.suspensionReason = null;
      updateData.canceledAt = null;

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

      updateData.status = newStatus;
      if (newStatus !== SubscriptionStatus.SUSPENDED) { updateData.suspendedAt = null; updateData.suspensionReason = null; }
      if (newStatus !== SubscriptionStatus.CANCELLED) updateData.canceledAt = null;
      const now = new Date();

      if (newStatus === SubscriptionStatus.SUSPENDED) {
        updateData.suspendedAt = now;
        updateData.suspensionReason = reason.trim();
      } else if (newStatus === SubscriptionStatus.CANCELLED) {
        updateData.canceledAt = now;
        updateData.cancelAtPeriodEnd = true;
        updateData.suspensionReason = reason.trim();
      } else if (newStatus === SubscriptionStatus.RESTRICTED || newStatus === SubscriptionStatus.READ_ONLY) {
        updateData.suspensionReason = reason.trim();
      } else if (newStatus === SubscriptionStatus.ACTIVE) {
        const periodDays = currentSub.billingInterval === BillingInterval.YEARLY ? 365 : 30;
        updateData.suspendedAt = null;
        updateData.canceledAt = null;
        updateData.suspensionReason = null;
        updateData.cancelAtPeriodEnd = false;
        updateData.currentPeriodStartsAt = now;
        updateData.currentPeriodEndsAt = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);
      }

      auditAction = "PLATFORM_SUBSCRIPTION_STATUS_CHANGED";
      auditDetails.previousStatus = currentSub.status;
      auditDetails.newStatus = newStatus;
    } else if (action === "ADJUST_BILLING") {
      if (billingInterval && Object.values(BillingInterval).includes(billingInterval as BillingInterval)) {
        updateData.billingInterval = billingInterval;
        const resolvedPrice = priceForSubscription({
          planId: currentSub.planId,
          billingInterval: billingInterval as BillingInterval,
          currency: currentSub.currency || currentHotel.currency,
        });
        if (resolvedPrice !== null) {
          updateData.amount = resolvedPrice;
        }
        auditDetails.billingInterval = billingInterval;
        auditDetails.currency = currentSub.currency;
      } else {
        return NextResponse.json(
          { error: "INVALID_BILLING_INTERVAL", message: "Billing interval must be MONTHLY or YEARLY." },
          { status: 400 }
        );
      }
      auditAction = "PLATFORM_BILLING_INTERVAL_ADJUSTED";
    } else {
      return NextResponse.json(
        {
          error: "INVALID_ACTION",
          message:
            "Supported actions: CHANGE_PLAN, EXTEND_TRIAL, CHANGE_STATUS, ADJUST_BILLING, ACTIVATE_MANUAL_PAYMENT, ISSUE_INVOICE, MARK_INVOICE_VOID.",
        },
        { status: 400 }
      );
    }

    // Ensure the resulting status is evaluable before committing any changes.
    try {
      evaluateSubscriptionStatus({ status: updateData.status ?? currentSub.status,
        trialEndsAt: updateData.trialEndsAt ?? currentSub.trialEndsAt,
        currentPeriodEndsAt: updateData.currentPeriodEndsAt ?? currentSub.currentPeriodEndsAt });
    } catch {
      return NextResponse.json({ error: "INVALID_SUBSCRIPTION_DATES", message: "Required subscription dates are missing or invalid." }, { status: 409 });
    }

    // 3. Atomically apply update and write audit log
    const updatedSub = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Hotel" WHERE id = ${hotelId} FOR UPDATE`;
      const hotel = await tx.hotel.findUnique({ where: { id: hotelId }, select: { status: true, currency: true } });
      const latest = await tx.subscription.findUnique({ where: { hotelId } });
      if (!hotel || !latest || hotel.currency !== currentHotel.currency || JSON.stringify(latest) !== JSON.stringify(currentSub)) throw new LifecycleChangedError();
      if (updateData.status) {
        const desiredHotelStatus = hotelStatusForSubscription(updateData.status);
        if (action === "CHANGE_STATUS" && latest.status === updateData.status && hotel.status === desiredHotelStatus) throw new LifecycleAlreadySetError();
        if ((hotel.status === "CANCELLED" || latest.status === "CANCELLED") && desiredHotelStatus !== "CANCELLED" && admin.platformRole !== PlatformRole.PLATFORM_SUPER_ADMIN) {
          throw new LifecycleForbiddenError();
        }
        await tx.hotel.update({ where: { id: hotelId }, data: { status: desiredHotelStatus } });
        auditDetails.previousHotelStatus = hotel.status;
        auditDetails.newHotelStatus = desiredHotelStatus;
      }
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
        currency: updatedSub.currency,
        amount: Number(updatedSub.amount),
        suspensionReason: updatedSub.suspensionReason,
      },
    });
  } catch (error) {
    if (error instanceof LifecycleChangedError) return NextResponse.json({ error: "CONCURRENT_CHANGE", message: "Subscription changed. Refresh and retry." }, { status: 409 });
    if (error instanceof LifecycleAlreadySetError) return NextResponse.json({ error: "ALREADY_IN_STATUS", message: "Hotel and subscription are already in that status." }, { status: 400 });
    if (error instanceof LifecycleForbiddenError) return NextResponse.json({ error: "FORBIDDEN", message: "Only Platform Super Administrators can reactivate a cancelled hotel." }, { status: 403 });
    console.error("Failed to update hotel subscription:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "Failed to update subscription." },
      { status: 500 }
    );
  }
}
