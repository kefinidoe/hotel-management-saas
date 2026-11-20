import { HotelRole, PlatformRole } from "@prisma/client";
import { redirect } from "next/navigation";
import { getBillingTenantContext, getTenantContext, requirePlatformRole, TenantAuthError, TenantContext } from "@/lib/tenant-context";
import { hasRole } from "@/lib/permissions";
import type { SaaSModule } from "@/lib/plans";
import { checkModuleEntitlement, getOrBootstrapSubscription } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";

// Resolve a tenant for server-rendered pages. Billing recovery deliberately
// uses the read-only context that remains available when a hotel is suspended.
async function resolvePageTenantContext(billingRecovery = false): Promise<TenantContext> {
  try {
    return billingRecovery ? await getBillingTenantContext() : await getTenantContext();
  } catch (error) {
    if (error instanceof TenantAuthError) {
      if (error.code === "UNAUTHENTICATED") redirect("/login");
      if (error.code === "NO_ACTIVE_MEMBERSHIP") {
        // An unselected sole suspended hotel is filtered out of the normal
        // operational context, but remains a valid billing recovery context.
        let recovery: TenantContext | undefined;
        try { recovery = await getBillingTenantContext(); } catch { /* no recoverable selection */ }
        if (recovery && recovery.hotel.status !== "ACTIVE" && recovery.hotel.status !== "TRIALING") {
          redirect("/dashboard/subscription?error=HOTEL_SUSPENDED");
        }
        redirect("/onboarding");
      }
      if (error.code === "HOTEL_SELECTION_REQUIRED" || error.code === "INVALID_HOTEL_SELECTION") {
        redirect("/select-hotel");
      }
      if (error.code === "MEMBERSHIP_SUSPENDED") redirect("/login?error=MembershipSuspended");
      if (error.code === "HOTEL_SUSPENDED") {
        if (billingRecovery) return getBillingTenantContext();
        redirect("/dashboard/subscription?error=HOTEL_SUSPENDED");
      }
    }
    redirect("/login");
  }
}

// Authorization helper for server-rendered dashboard pages. API guards alone
// are not enough because these pages query Prisma directly before rendering.
export async function requirePageRole(
  allowed: readonly HotelRole[],
  module?: SaaSModule
): Promise<TenantContext> {
  const context = await resolvePageTenantContext();
  if (!hasRole(context.role, allowed)) redirect("/dashboard");

  let subscription;
  try {
    subscription = await getOrBootstrapSubscription(context.hotelId);
  } catch {
    redirect("/dashboard/subscription?error=SUBSCRIPTION_STATUS_UNAVAILABLE");
  }
  if (subscription.effectiveStatus === "SUSPENDED" || subscription.effectiveStatus === "CANCELLED") {
    redirect(`/dashboard/subscription?error=SUBSCRIPTION_${subscription.effectiveStatus}`);
  }

  if (module) {
    let entitlement;
    try {
      entitlement = await checkModuleEntitlement(context.hotelId, module, "read");
    } catch {
      redirect("/dashboard/subscription?error=SUBSCRIPTION_STATUS_UNAVAILABLE");
    }
    if (!entitlement!.allowed) {
      const code = entitlement!.code || "MODULE_NOT_ENTITLED";
      redirect(`/dashboard/subscription?error=${encodeURIComponent(code)}`);
    }
  }

  return context;
}

// The subscription page is the recovery surface for expired/suspended tenants;
// it must not require the operational hotel context or an active plan.
export async function requireBillingPageRole(allowed: readonly HotelRole[]): Promise<TenantContext> {
  const context = await resolvePageTenantContext(true);
  if (!hasRole(context.role, allowed)) redirect("/dashboard");
  return context;
}

export async function requirePlatformPageRole(
  allowed: readonly PlatformRole[] = [
    PlatformRole.PLATFORM_SUPER_ADMIN,
    PlatformRole.PLATFORM_SUPPORT,
    PlatformRole.PLATFORM_BILLING,
  ]
): Promise<{ userId: string; platformRole: PlatformRole; user: { name: string; email: string } }> {
  try {
    const admin = await requirePlatformRole(allowed);
    const user = await prisma.user.findUnique({
      where: { id: admin.userId },
      select: { name: true, email: true },
    });
    return {
      userId: admin.userId,
      platformRole: admin.platformRole,
      user: user || { name: "Platform Admin", email: "" },
    };
  } catch (error) {
    if (error instanceof TenantAuthError) {
      if (error.code === "UNAUTHENTICATED") redirect("/login");
      if (error.code === "FORBIDDEN") redirect("/dashboard");
    }
    redirect("/login");
    return null as never;
  }
}
