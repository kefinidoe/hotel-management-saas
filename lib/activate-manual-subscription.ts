import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getPlan, PRICING_CONFIG } from "@/lib/plans";
import { generateNextInvoiceNumber, roundSubscriptionMoney } from "@/lib/subscription-invoices";
import { calculateManualPaymentPeriod, type ManualSubscriptionPayment } from "@/lib/manual-subscription-payment";

export class ManualPaymentConflictError extends Error {}
export class ManualSubscriptionNotFoundError extends Error {}
export class ManualActivationForbiddenError extends Error {}

/** All manual activations share an advisory lock. The companion unique index is
 * also required to protect against other database writers. Never treat entry of
 * a reference as proof of payment: the administrator must verify it first. */
export async function activateManualSubscription(
  hotelId: string,
  admin: { userId: string; platformRole: string },
  payment: ManualSubscriptionPayment,
  now = new Date(),
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('subscription-manual-payment'))::text AS locked`;
    const duplicate = await tx.$queryRaw<Array<{ duplicate: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM "AuditLog" WHERE "entity" = 'Subscription'
          AND upper(regexp_replace("metadata"->>'referenceCode', '^[[:space:]]+|[[:space:]]+$', '', 'g')) = ${payment.referenceCode}
        UNION ALL
        SELECT 1 FROM "Subscription" AS s
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(s."metadata"->'payments') = 'array'
              THEN s."metadata"->'payments' ELSE '[]'::jsonb END
          ) AS p(payment)
          WHERE upper(regexp_replace(p.payment->>'referenceCode', '^[[:space:]]+|[[:space:]]+$', '', 'g')) = ${payment.referenceCode}
        UNION ALL
        SELECT 1 FROM "SubscriptionInvoice"
          WHERE "paymentReference" IS NOT NULL
            AND upper(regexp_replace("paymentReference", '^[[:space:]]+|[[:space:]]+$', '', 'g')) = ${payment.referenceCode}
      ) AS duplicate
    `;
    if (duplicate[0]?.duplicate !== false) throw new ManualPaymentConflictError("Payment reference has already been used, or could not be verified.");

    await tx.$queryRaw`SELECT id FROM "Hotel" WHERE id = ${hotelId} FOR UPDATE`;
    const hotel = await tx.hotel.findUnique({ where: { id: hotelId }, select: { status: true } });
    await tx.$queryRaw`SELECT "id" FROM "Subscription" WHERE "hotelId" = ${hotelId} FOR UPDATE`;
    const current = await tx.subscription.findUnique({ where: { hotelId } });
    if (!hotel || !current) throw new ManualSubscriptionNotFoundError("Subscription not found.");
    if ((hotel.status === "CANCELLED" || current.status === "CANCELLED") && admin.platformRole !== "PLATFORM_SUPER_ADMIN") {
      throw new ManualActivationForbiddenError("Only Platform Super Administrators can reactivate a cancelled hotel.");
    }
    const metadata = current.metadata;
    if (metadata !== null && (typeof metadata !== "object" || Array.isArray(metadata))) throw new Error("Invalid subscription metadata.");
    const data = (metadata ?? {}) as Prisma.JsonObject;
    if (data.payments !== undefined && !Array.isArray(data.payments)) throw new Error("Invalid subscription payment history.");
    const period = calculateManualPaymentPeriod({ status: current.status, currentPeriodStartsAt: current.currentPeriodStartsAt, currentPeriodEndsAt: current.currentPeriodEndsAt, durationDays: payment.durationDays, now });

    const amountDec = roundSubscriptionMoney(payment.amountPaid);
    const invoiceNumber = await generateNextInvoiceNumber(tx, now);
    const plan = getPlan(current.planId);

    const entry: Prisma.InputJsonObject = {
      referenceCode: payment.referenceCode, amountPaid: amountDec.toNumber(), currency: current.currency,
      durationDays: payment.durationDays, reason: payment.reason, adminUserId: admin.userId,
      adminRole: admin.platformRole, recordedAt: now.toISOString(),
      periodStartsAt: period.currentPeriodStartsAt.toISOString(), periodEndsAt: period.currentPeriodEndsAt.toISOString(),
      method: "MANUAL_COOP_MPESA", previousHotelStatus: hotel.status, previousSubscriptionStatus: current.status,
      invoiceNumber,
    };
    await tx.hotel.update({ where: { id: hotelId }, data: { status: "ACTIVE" } });

    const updated = await tx.subscription.update({
      where: { hotelId },
      data: {
        status: "ACTIVE",
        suspendedAt: null,
        canceledAt: null,
        suspensionReason: null,
        cancelAtPeriodEnd: false,
        currentPeriodStartsAt: period.currentPeriodStartsAt,
        currentPeriodEndsAt: period.currentPeriodEndsAt,
        metadata: { ...data, payments: [...(Array.isArray(data.payments) ? data.payments : []), entry] } as Prisma.InputJsonObject,
      },
    });

    const invoice = await tx.subscriptionInvoice.create({
      data: {
        hotelId,
        subscriptionId: updated.id,
        invoiceNumber,
        status: "PAID",
        planId: current.planId,
        planName: plan.name,
        billingInterval: current.billingInterval ?? "MONTHLY",
        currency: current.currency || "KES",
        subtotal: new Prisma.Decimal(amountDec.toFixed(2)),
        taxAmount: new Prisma.Decimal("0.00"),
        amount: new Prisma.Decimal(amountDec.toFixed(2)),
        amountPaid: new Prisma.Decimal(amountDec.toFixed(2)),
        periodStartsAt: period.currentPeriodStartsAt,
        periodEndsAt: period.currentPeriodEndsAt,
        issuedAt: now,
        dueAt: now,
        paidAt: now,
        paymentMethod: "MANUAL_COOP_MPESA",
        paymentReference: payment.referenceCode,
        recordedByUserId: admin.userId,
        notes: payment.reason,
        metadata: {
          durationDays: payment.durationDays,
          adminRole: admin.platformRole,
          isScheduleApproved: PRICING_CONFIG.isScheduleApproved,
        },
      },
    });

    // The audit insert is atomic with activation. Database trigger protection
    // requires its migration to be deployed; a separate restricted runtime role
    // and independent audit storage are still needed against privileged changes.
    await tx.auditLog.create({
      data: {
        hotelId,
        userId: admin.userId,
        action: "PLATFORM_MANUAL_PAYMENT_ACTIVATED",
        entity: "Subscription",
        entityId: updated.id,
        metadata: {
          ...entry,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
        },
      },
    });

    return {
      ...updated,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
    };
  });
}
