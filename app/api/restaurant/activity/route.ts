import { NextResponse } from "next/server";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { getRestaurantActivity } from "@/lib/restaurant-dashboard";

export const dynamic = "force-dynamic";

export async function GET() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.RESTAURANT_POS);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESTAURANT_POS");
  if (blocked) return blocked;

  return NextResponse.json(await getRestaurantActivity(tenant.hotelId));
}
