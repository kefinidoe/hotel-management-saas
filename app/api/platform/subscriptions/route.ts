import { NextResponse } from "next/server";
import Decimal from "decimal.js";
import { getPlatformAdminFromRoute } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  getAllPlans,
  SUBSCRIPTION_PLANS,
  getPlan,
} from "@/lib/plans";
import { evaluateSubscriptionStatus } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const admin = await getPlatformAdminFromRoute();
  if (admin instanceof Response || (admin && "status" in admin)) return admin as any;

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim().toLowerCase() || "";
  const statusFilter = searchParams.get("status")?.trim().toUpperCase() || "";
  const planFilter = searchParams.get("plan")?.trim().toUpperCase() || "";

  try {
    // 1. Fetch all hotels with their subscriptions, rooms count, and staff count
    const hotels = await prisma.hotel.findMany({
      include: {
        subscription: true,
        _count: {
          select: {
            rooms: { where: { isActive: true } },
            memberships: { where: { status: "ACTIVE" } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    let trialingCount = 0;
    let missingCount = 0;
    let activeCount = 0;
    let pastDueCount = 0;
    let restrictedCount = 0;
    let readOnlyCount = 0;
    let suspendedCount = 0;
    let cancelledCount = 0;
    let expiringSoonCount = 0;
    let overdueCount = 0;
    let payingCount = 0;
    let nonPayingOrTrialCount = 0;

    const mrrByCurrencyDecimals: Record<string, Decimal> = {
      KES: new Decimal(0),
      USD: new Decimal(0),
    };
    const arrByCurrencyDecimals: Record<string, Decimal> = {
      KES: new Decimal(0),
      USD: new Decimal(0),
    };
    const pastDueAtRiskByCurrencyDecimals: Record<string, Decimal> = {
      KES: new Decimal(0),
      USD: new Decimal(0),
    };

    const enriched = hotels.map((h) => {
      const sub = h.subscription;
      const plan = getPlan(sub?.planId);
      const evalResult = sub
        ? evaluateSubscriptionStatus({
            status: sub.status,
            trialEndsAt: sub.trialEndsAt,
            currentPeriodEndsAt: sub.currentPeriodEndsAt,
          })
        : {
            effectiveStatus: "MISSING" as any,
            isOperational: false,
            isOverdue: false,
            daysRemaining: null,
          };

      const currency = (sub?.currency || h.currency || "KES").toUpperCase();
      if (!mrrByCurrencyDecimals[currency]) mrrByCurrencyDecimals[currency] = new Decimal(0);
      if (!arrByCurrencyDecimals[currency]) arrByCurrencyDecimals[currency] = new Decimal(0);
      if (!pastDueAtRiskByCurrencyDecimals[currency]) {
        pastDueAtRiskByCurrencyDecimals[currency] = new Decimal(0);
      }

      const subAmountDecimal = sub ? new Decimal(String(sub.amount)) : new Decimal(0);
      const isYearly = sub?.billingInterval === "YEARLY";
      const monthlyEquivalent = isYearly ? subAmountDecimal.div(12) : subAmountDecimal;
      const yearlyEquivalent = isYearly ? subAmountDecimal : subAmountDecimal.mul(12);

      // Aggregates
      if (evalResult.effectiveStatus === "TRIALING") {
        trialingCount++;
        nonPayingOrTrialCount++;
      } else if (evalResult.effectiveStatus === "ACTIVE") {
        activeCount++;
        if (subAmountDecimal.gt(0)) {
          payingCount++;
          mrrByCurrencyDecimals[currency] = mrrByCurrencyDecimals[currency].plus(monthlyEquivalent);
          arrByCurrencyDecimals[currency] = arrByCurrencyDecimals[currency].plus(yearlyEquivalent);
        } else {
          nonPayingOrTrialCount++;
        }
      } else if (evalResult.effectiveStatus === "PAST_DUE" || evalResult.effectiveStatus === "TRIAL_EXPIRED") {
        pastDueCount++;
        nonPayingOrTrialCount++;
        if (subAmountDecimal.gt(0) && evalResult.effectiveStatus === "PAST_DUE") {
          pastDueAtRiskByCurrencyDecimals[currency] =
            pastDueAtRiskByCurrencyDecimals[currency].plus(monthlyEquivalent);
        }
      } else if (evalResult.effectiveStatus === "RESTRICTED") {
        restrictedCount++;
        nonPayingOrTrialCount++;
        if (subAmountDecimal.gt(0)) {
          pastDueAtRiskByCurrencyDecimals[currency] =
            pastDueAtRiskByCurrencyDecimals[currency].plus(monthlyEquivalent);
        }
      } else if (evalResult.effectiveStatus === "READ_ONLY") {
        readOnlyCount++;
        nonPayingOrTrialCount++;
        if (subAmountDecimal.gt(0)) {
          pastDueAtRiskByCurrencyDecimals[currency] =
            pastDueAtRiskByCurrencyDecimals[currency].plus(monthlyEquivalent);
        }
      } else if (evalResult.effectiveStatus === "SUSPENDED") {
        suspendedCount++;
        nonPayingOrTrialCount++;
      } else if (evalResult.effectiveStatus === "CANCELLED") {
        cancelledCount++;
        nonPayingOrTrialCount++;
      } else if (evalResult.effectiveStatus === "MISSING") {
        missingCount++;
      }

      if (evalResult.isOverdue) overdueCount++;

      // Check if trial is expiring soon (<= 7 days remaining)
      if (
        evalResult.effectiveStatus === "TRIALING" &&
        evalResult.daysRemaining !== null &&
        evalResult.daysRemaining <= 7
      ) {
        expiringSoonCount++;
      }

      return {
        hotelId: h.id,
        hotelName: h.name,
        hotelSlug: h.slug,
        hotelStatus: h.status,
        currency: h.currency,
        createdAt: h.createdAt.toISOString(),
        subscription: sub
          ? {
              id: sub.id,
              planId: sub.planId,
              planName: plan.name,
              storedStatus: sub.status,
              effectiveStatus: evalResult.effectiveStatus,
              isOperational: evalResult.isOperational,
              isOverdue: evalResult.isOverdue,
              daysRemaining: evalResult.daysRemaining,
              trialStartsAt: sub.trialStartsAt.toISOString(),
              trialEndsAt: sub.trialEndsAt ? sub.trialEndsAt.toISOString() : null,
              currentPeriodStartsAt: sub.currentPeriodStartsAt.toISOString(),
              currentPeriodEndsAt: sub.currentPeriodEndsAt ? sub.currentPeriodEndsAt.toISOString() : null,
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
              billingInterval: sub.billingInterval,
              amount: Number(sub.amount),
              amountExact: String(sub.amount),
              currency,
              suspensionReason: sub.suspensionReason,
            }
          : {
              id: `missing-${h.id}`,
              planId: plan.id,
              planName: plan.name,
              storedStatus: "MISSING",
              effectiveStatus: evalResult.effectiveStatus,
              isOperational: false,
              isOverdue: false,
              daysRemaining: null,
              trialStartsAt: null,
              trialEndsAt: null,
              currentPeriodStartsAt: null,
              currentPeriodEndsAt: null,
              cancelAtPeriodEnd: false,
              billingInterval: "MONTHLY",
              amount: 0,
              amountExact: "0",
              currency,
              suspensionReason: null,
            },
        usage: {
          rooms: {
            current: h._count.rooms,
            max: plan.limits.maxRooms,
          },
          staff: {
            current: h._count.memberships,
            max: plan.limits.maxStaff,
          },
        },
      };
    });

    // 2. Filter records
    const filtered = enriched.filter((item) => {
      if (q) {
        const matchesName = item.hotelName.toLowerCase().includes(q);
        const matchesSlug = item.hotelSlug.toLowerCase().includes(q);
        if (!matchesName && !matchesSlug) return false;
      }
      if (statusFilter && item.subscription.effectiveStatus !== statusFilter) {
        return false;
      }
      if (planFilter && item.subscription.planId.toUpperCase() !== planFilter) {
        return false;
      }
      return true;
    });

    const roundCurrencyMap = (map: Record<string, Decimal>): Record<string, number> =>
      Object.fromEntries(
        Object.entries(map).map(([currency, total]) => [
          currency,
          total.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber(),
        ])
      );

    return NextResponse.json({
      summary: {
        totalHotels: hotels.length,
        trialingCount,
        activeCount,
        pastDueCount,
        restrictedCount,
        readOnlyCount,
        suspendedCount,
        cancelledCount,
        missingCount,
        expiringSoonCount,
        overdueCount,
        payingCount,
        nonPayingOrTrialCount,
        mrrByCurrency: roundCurrencyMap(mrrByCurrencyDecimals),
        arrByCurrency: roundCurrencyMap(arrByCurrencyDecimals),
        pastDueAtRiskByCurrency: roundCurrencyMap(pastDueAtRiskByCurrencyDecimals),
        revenueReportingPolicy: {
          normalization: "Annual subscriptions normalized to monthly equivalents (amount / 12) for MRR.",
          exclusions: "Trials (active or expired), restricted, read-only, suspended, cancelled, and $0 accounts are strictly excluded from paid MRR.",
          pastDueHandling: "Past-due, restricted, and read-only accounts are excluded from active paid MRR and reported under pastDueAtRiskByCurrency.",
          currencySeparation: "Revenues are tracked discretely by currency (KES, USD) without synthetic exchange rate conversions.",
        },
      },
      availablePlans: getAllPlans(),
      subscriptions: filtered,
    });
  } catch (error) {
    console.error("Failed to query platform subscriptions:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "Failed to fetch platform subscriptions." },
      { status: 500 }
    );
  }
}
