import { NextResponse } from "next/server";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { getRestaurantPaymentMethods } from "@/lib/restaurant-dashboard";

export async function GET() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.PAYMENT_OPERATIONS);
  if (forbidden) return forbidden;

  return NextResponse.json(await getRestaurantPaymentMethods(tenant.hotelId));
}
