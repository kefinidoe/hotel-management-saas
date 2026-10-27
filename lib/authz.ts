import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { HotelRole, PlatformRole } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import {
  getTenantContext,
  requireHotelRole,
  requirePlatformRole,
  TenantAuthError,
  type TenantContext,
} from "@/lib/tenant-context";

// Re-exported so existing and new imports remain stable.
export { ROLE_GROUPS } from "@/lib/permissions";
export { getTenantContext, requireHotelRole, requirePlatformRole, TenantAuthError };
export type { TenantContext };

export async function requireAuth() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return session;
}

export async function getTenantFromRoute(): Promise<TenantContext | NextResponse> {
  try {
    return await getTenantContext();
  } catch (error) {
    if (error instanceof TenantAuthError) {
      const response = NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.statusCode }
      );
      if (error.clearCookie) {
        response.cookies.delete("active_hotel_id");
      }
      return response;
    }
    return NextResponse.json({ error: "UNAUTHORIZED", message: "Authentication required" }, { status: 401 });
  }
}

export function requireRole(roleOrSession: any, allowed: readonly HotelRole[]) {
  const role: HotelRole | undefined =
    typeof roleOrSession === "string"
      ? (roleOrSession as HotelRole)
      : roleOrSession?.role || roleOrSession?.user?.role;

  if (!role || !allowed.includes(role)) {
    return NextResponse.json(
      { error: "You don't have permission to do that." },
      { status: 403 }
    );
  }
  return null;
}

export async function getPlatformAdminFromRoute(
  allowedRoles: readonly PlatformRole[] = [
    PlatformRole.PLATFORM_SUPER_ADMIN,
    PlatformRole.PLATFORM_SUPPORT,
    PlatformRole.PLATFORM_BILLING,
  ]
): Promise<{ userId: string; platformRole: PlatformRole } | NextResponse> {
  try {
    return await requirePlatformRole(allowedRoles);
  } catch (error) {
    if (error instanceof TenantAuthError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.statusCode }
      );
    }
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "Authentication required" },
      { status: 401 }
    );
  }
}

// SaaS Entitlements & Subscription helpers
export {
  checkModuleEntitlement,
  checkUsageLimit,
  getOrBootstrapSubscription,
  evaluateSubscriptionStatus,
  getHotelUsageAndSubscription,
} from "@/lib/entitlements";
export { getPlan, getAllPlans, isPlanAvailableForNewSub, SUBSCRIPTION_PLANS } from "@/lib/plans";
export type { SaaSModule, SubscriptionPlan } from "@/lib/plans";
export type { EvaluatedSubscriptionState, HotelSubscriptionContext } from "@/lib/entitlements";

export async function requireModule(
  hotelId: string,
  module: import("@/lib/plans").SaaSModule
): Promise<NextResponse | null> {
  const { checkModuleEntitlement } = await import("@/lib/entitlements");
  const check = await checkModuleEntitlement(hotelId, module);
  if (!check.allowed) {
    return NextResponse.json(
      { error: check.code || "MODULE_NOT_ENTITLED", message: check.reason },
      { status: 403 }
    );
  }
  return null;
}

export async function getEntitledTenantFromRoute(
  module: import("@/lib/plans").SaaSModule,
  allowedRoles?: readonly HotelRole[]
): Promise<TenantContext | NextResponse> {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof Response || (tenant && "status" in tenant)) return tenant as any;

  if (allowedRoles) {
    const forbidden = requireRole(tenant.role, allowedRoles);
    if (forbidden) return forbidden;
  }

  const blocked = await requireModule(tenant.hotelId, module);
  if (blocked) return blocked;

  return tenant;
}
