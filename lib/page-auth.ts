import { HotelRole, PlatformRole } from "@prisma/client";
import { redirect } from "next/navigation";
import { getTenantContext, requirePlatformRole, TenantAuthError, TenantContext } from "@/lib/tenant-context";
import { hasRole } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

// Authorization helper for server-rendered dashboard pages. API guards alone
// are not enough because these pages query Prisma directly before rendering.
export async function requirePageRole(allowed: readonly HotelRole[]): Promise<TenantContext> {
  let context!: TenantContext;
  try {
    context = await getTenantContext();
  } catch (error) {
    if (error instanceof TenantAuthError) {
      if (error.code === "UNAUTHENTICATED") redirect("/login");
      if (error.code === "NO_ACTIVE_MEMBERSHIP") redirect("/onboarding");
      if (error.code === "HOTEL_SELECTION_REQUIRED" || error.code === "INVALID_HOTEL_SELECTION") {
        redirect("/select-hotel");
      }
      if (error.code === "MEMBERSHIP_SUSPENDED") redirect("/login?error=MembershipSuspended");
      if (error.code === "HOTEL_SUSPENDED") redirect("/login?error=HotelSuspended");
    }
    redirect("/login");
  }

  if (!hasRole(context.role, allowed)) {
    redirect("/dashboard");
  }

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
