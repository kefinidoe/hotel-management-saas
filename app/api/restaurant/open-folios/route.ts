import { NextResponse } from "next/server";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { getRestaurantOpenFolios } from "@/lib/restaurant-dashboard";

export async function GET() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.RESTAURANT_POS);
  if (forbidden) return forbidden;

  const { checkModuleEntitlement } = await import("@/lib/entitlements");
  const moduleCheck = await checkModuleEntitlement(tenant.hotelId, "RESTAURANT_POS");
  if (!moduleCheck.allowed) {
    return NextResponse.json(
      {
        error: moduleCheck.code || "MODULE_NOT_ENTITLED",
        message: moduleCheck.reason,
      },
      { status: 403 }
    );
  }

  return NextResponse.json(await getRestaurantOpenFolios(tenant.hotelId));
}
