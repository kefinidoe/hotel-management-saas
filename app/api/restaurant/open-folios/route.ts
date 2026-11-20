import { NextResponse } from "next/server";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { getRestaurantOpenFolios } from "@/lib/restaurant-dashboard";

export async function GET() {
  const tenant = await getTenantFromRoute("read");
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.RESTAURANT_POS);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESTAURANT_POS", "read");
  if (blocked) return blocked;

  const response = NextResponse.json(await getRestaurantOpenFolios(tenant.hotelId));
  response.headers.set("X-Active-Hotel-Id", tenant.hotelId);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
