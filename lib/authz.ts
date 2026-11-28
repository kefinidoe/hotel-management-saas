import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { HotelRole, PlatformRole } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import {
  getTenantContext,
  getBillingTenantContext,
  requireHotelRole,
  requirePlatformRole,
  TenantAuthError,
  type TenantContext,
} from "@/lib/tenant-context";

// Re-exported so existing and new imports remain stable.
export { ROLE_GROUPS } from "@/lib/permissions";
export { getTenantContext, getBillingTenantContext, requireHotelRole, requirePlatformRole, TenantAuthError };
export type { TenantContext };

export async function requireAuth() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return session;
}

export async function getTenantFromRoute(access: "read" | "write" = "write"): Promise<TenantContext | NextResponse> {
  try {
    const tenant = await getTenantContext();
    const { getOrBootstrapSubscription } = await import("@/lib/entitlements");
    const sub = await getOrBootstrapSubscription(tenant.hotelId);
    const readOnlyAllowed =
      sub.effectiveStatus === "TRIAL_EXPIRED" ||
      sub.effectiveStatus === "PAST_DUE" ||
      sub.effectiveStatus === "RESTRICTED" ||
      sub.effectiveStatus === "READ_ONLY";
    if (!sub.isOperational && (access === "write" || !readOnlyAllowed)) {
      const code =
        sub.effectiveStatus === "SUSPENDED"
          ? "SUBSCRIPTION_SUSPENDED"
          : sub.effectiveStatus === "PAST_DUE"
          ? "SUBSCRIPTION_PAST_DUE"
          : sub.effectiveStatus === "RESTRICTED"
          ? "SUBSCRIPTION_RESTRICTED"
          : sub.effectiveStatus === "READ_ONLY"
          ? "SUBSCRIPTION_READ_ONLY"
          : sub.effectiveStatus === "TRIAL_EXPIRED"
          ? "TRIAL_EXPIRED"
          : "SUBSCRIPTION_CANCELLED";
      return NextResponse.json({ error: code, message: "Subscription access is restricted. Please visit billing." }, { status: 403 });
    }
    return tenant;
  } catch (error) {
    if (error instanceof TenantAuthError) {
      const response = NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.statusCode }
      );
      // A verified suspended hotel remains selected so billing recovery works
      // for users with multiple memberships. Invalid selections still clear.
      if (error.clearCookie && error.code !== "HOTEL_SUSPENDED") {
        response.cookies.delete("active_hotel_id");
      }
      return response;
    }
    return NextResponse.json({ error: "SUBSCRIPTION_STATUS_UNAVAILABLE", message: "Subscription status is temporarily unavailable." }, { status: 503 });
  }
}

export async function getBillingTenantFromRoute(): Promise<TenantContext | NextResponse> {
  try {
    return await getBillingTenantContext();
  } catch (error) {
    if (error instanceof TenantAuthError) {
      const response = NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.statusCode }
      );
      if (error.clearCookie) response.cookies.delete("active_hotel_id");
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
  getSubscriptionLifecycleSummary,
} from "@/lib/entitlements";
export { getPlan, getAllPlans, isPlanAvailableForNewSub, SUBSCRIPTION_PLANS } from "@/lib/plans";
export type { SaaSModule, SubscriptionPlan } from "@/lib/plans";
export type { EvaluatedSubscriptionState, HotelSubscriptionContext, SubscriptionLifecycleSummary } from "@/lib/entitlements";

export async function requireModule(
  hotelId: string,
  module: import("@/lib/plans").SaaSModule,
  access: "read" | "write" = "write"
): Promise<NextResponse | null> {
  try {
    const { checkModuleEntitlement } = await import("@/lib/entitlements");
    const check = await checkModuleEntitlement(hotelId, module, access);
    if (!check.allowed) {
      return NextResponse.json(
        { error: check.code || "MODULE_NOT_ENTITLED", message: check.reason },
        { status: check.code === "SUBSCRIPTION_STATUS_UNAVAILABLE" ? 503 : 403 }
      );
    }
    return null;
  } catch {
    // An unavailable subscription database is not an expired subscription and
    // must never be interpreted as permission to perform an operation.
    return NextResponse.json(
      { error: "SUBSCRIPTION_STATUS_UNAVAILABLE", message: "Subscription status is temporarily unavailable." },
      { status: 503 }
    );
  }
}

export async function requireUsageLimit(
  hotelId: string,
  limitType: "maxRooms" | "maxStaff",
  increment = 1
): Promise<NextResponse | null> {
  try {
    const { checkUsageLimit } = await import("@/lib/entitlements");
    const check = await checkUsageLimit(hotelId, limitType, increment);
    if (check.allowed) return null;
    return NextResponse.json(
      { error: check.code || "PLAN_LIMIT_EXCEEDED", message: check.reason },
      { status: check.code === "SUBSCRIPTION_STATUS_UNAVAILABLE" ? 503 : 403 }
    );
  } catch {
    return NextResponse.json(
      { error: "SUBSCRIPTION_STATUS_UNAVAILABLE", message: "Subscription status is temporarily unavailable." },
      { status: 503 }
    );
  }
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
