import { NextResponse } from "next/server";
import { getBillingTenantFromRoute, requireRole } from "@/lib/authz";
import { ROLE_GROUPS } from "@/lib/permissions";
import { getHotelUsageAndSubscription, SubscriptionStatusUnavailableError, PAST_DUE_GRACE_PERIOD_DAYS } from "@/lib/entitlements";
import { ORDERED_ROOM_BANDS, PRICING_CONFIG, calculateBandPricing, BillingInterval } from "@/lib/plans";

export const dynamic = "force-dynamic";

export async function GET() {
  const tenant = await getBillingTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.STAFF_ADMIN);
  if (forbidden) return forbidden;

  try {
    const details = await getHotelUsageAndSubscription(tenant.hotelId);
    const currency = tenant.hotel.currency || "KES";

    // Pre-calculate monthly and yearly options for this hotel's billable room count
    const monthlyCalculation = calculateBandPricing({
      roomCount: details.breakdown.billableActiveRooms,
      billingInterval: BillingInterval.MONTHLY,
      currency,
    });

    const yearlyCalculation = calculateBandPricing({
      roomCount: details.breakdown.billableActiveRooms,
      billingInterval: BillingInterval.YEARLY,
      currency,
    });

    return NextResponse.json({
      hotel: {
        id: tenant.hotelId,
        name: tenant.hotel.name,
        slug: tenant.hotel.slug,
        currency,
        status: tenant.hotel.status,
      },
      subscription: {
        id: details.subscription.id,
        planId: details.subscription.planId,
        bandName: details.subscription.plan.name,
        tagline: details.subscription.plan.tagline,
        description: details.subscription.plan.description,
        storedStatus: details.subscription.storedStatus,
        effectiveStatus: details.subscription.effectiveStatus,
        isOperational: details.subscription.isOperational,
        isOverdue: details.subscription.isOverdue,
        daysRemaining: details.subscription.daysRemaining,
        trialStartsAt: details.subscription.trialStartsAt.toISOString(),
        trialEndsAt: details.subscription.trialEndsAt ? details.subscription.trialEndsAt.toISOString() : null,
        currentPeriodStartsAt: details.subscription.currentPeriodStartsAt.toISOString(),
        currentPeriodEndsAt: details.subscription.currentPeriodEndsAt ? details.subscription.currentPeriodEndsAt.toISOString() : null,
        billingInterval: details.subscription.billingInterval,
        amount: details.subscription.amount,
        currency: details.subscription.currency,
        modules: details.subscription.plan.modules,
        limits: details.subscription.plan.limits,
      },
      billableBreakdown: {
        totalConfiguredRooms: details.breakdown.totalConfiguredRooms,
        billableActiveRooms: details.breakdown.billableActiveRooms,
        decommissionedRooms: details.breakdown.decommissionedRooms,
        statusBreakdown: details.breakdown.statusBreakdown,
        isOverBandCapacity: details.breakdown.isOverBandCapacity,
        roomsRemainingInBand: details.breakdown.roomsRemainingInBand,
        currentBandId: details.breakdown.currentBand.id,
        recommendedBandId: details.breakdown.recommendedBand.id,
        recommendedBandName: details.breakdown.recommendedBand.name,
      },
      pricingSchedule: {
        isScheduleApproved: PRICING_CONFIG.isScheduleApproved,
        defaultAnnualDiscountPercent: PRICING_CONFIG.defaultAnnualDiscountPercent,
        notes: PRICING_CONFIG.notes,
        currentPricing: details.pricing,
        options: {
          monthly: monthlyCalculation,
          yearly: yearlyCalculation,
        },
      },
      usage: details.usage,
      roomBands: ORDERED_ROOM_BANDS.map((b) => ({
        id: b.id,
        name: b.name,
        tagline: b.tagline,
        description: b.description,
        minRooms: b.minRooms,
        maxRooms: isFinite(b.maxRooms) ? b.maxRooms : "201+",
        isCustomQuote: b.isCustomQuote,
        monthlyPriceKES: b.monthlyPriceKES,
        monthlyPriceUSD: b.monthlyPriceUSD,
        yearlyPriceKES: b.yearlyPriceKES,
        yearlyPriceUSD: b.yearlyPriceUSD,
        annualDiscountPercentage: b.annualDiscountPercentage,
        modules: b.modules,
        limits: b.limits,
        badge: b.badge || null,
        isCurrentBand: b.id === details.subscription.planId,
        isRecommended: b.id === details.breakdown.recommendedBand.id,
      })),
      policy: {
        pastDueGracePeriodDays: PAST_DUE_GRACE_PERIOD_DAYS,
        billableDefinition: "Billable rooms include all active rooms in the property inventory (including temporary out-of-order and maintenance rooms). Decommissioned or archived rooms are excluded.",
        additions: "Rooms may be added up to the active band limit. Exceeding the band boundary requires stepping up to the corresponding room band.",
        removals: "Decommissioning rooms reduces your billable room count. Downgrading to a lower room band preserves existing room records without destructive deletion.",
        featureParity: "All core modules (Front Desk, Folios, Housekeeping, Restaurant POS, Inventory, Expenses, Maintenance, Reports) are included across all room bands.",
      },
      note: "Live payment processing is managed in a separate phase. Contact platform administration or support for plan upgrades.",
    });
  } catch (error) {
    console.error("Failed to fetch tenant subscription:", error);
    if (error instanceof SubscriptionStatusUnavailableError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.statusCode }
      );
    }
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "Failed to retrieve subscription status." },
      { status: 500 }
    );
  }
}
