import { NextResponse } from "next/server";
import { getBillingTenantFromRoute, requireRole } from "@/lib/authz";
import { getOrBootstrapSubscription } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import { ROLE_GROUPS } from "@/lib/permissions";
import { getBillingHistoryForHotel } from "@/lib/subscription-invoices";

export const dynamic = "force-dynamic";

export async function GET() {
  const tenant = await getBillingTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.STAFF_ADMIN);
  if (forbidden) return forbidden;

  try {
    const subscription = await getOrBootstrapSubscription(tenant.hotelId);
    const rawSub =
      typeof (prisma as any).subscription?.findUnique === "function"
        ? await prisma.subscription.findUnique({
            where: { hotelId: tenant.hotelId },
            select: { metadata: true },
          })
        : null;

    const billingHistory = await getBillingHistoryForHotel(tenant.hotelId, {
      id: subscription.id,
      planId: subscription.planId,
      planName: subscription.plan.name,
      billingInterval: subscription.billingInterval,
      currency: subscription.currency,
      metadata: rawSub?.metadata ?? null,
    });

    return NextResponse.json({
      hotelId: tenant.hotelId,
      invoices: billingHistory,
      billingHistory,
    });
  } catch (error) {
    console.error("Failed to fetch subscription billing history:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "Failed to retrieve billing history." },
      { status: 500 }
    );
  }
}
