import { NextResponse } from "next/server";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { getRestaurantPaymentMethods } from "@/lib/restaurant-dashboard";

export async function GET() {
  const tenant = await getTenantFromRoute("read");
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.PAYMENT_OPERATIONS);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESTAURANT_POS", "read");
  if (blocked) return blocked;

  return NextResponse.json(await getRestaurantPaymentMethods(tenant.hotelId));
}
