import { redirect } from "next/navigation";
import Link from "next/link";
import { requirePlatformRole, TenantAuthError } from "@/lib/tenant-context";
import { PlatformRole } from "@prisma/client";
import { Building2, LogOut, ArrowLeft, AlertTriangle } from "lucide-react";
import HotelFlowBrand from "@/components/HotelFlowBrand";
import { PRODUCT_NAME } from "@/lib/brand";

export const dynamic = "force-dynamic";

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let admin: { userId: string; platformRole: PlatformRole };

  try {
    admin = await requirePlatformRole([
      PlatformRole.PLATFORM_SUPER_ADMIN,
      PlatformRole.PLATFORM_SUPPORT,
      PlatformRole.PLATFORM_BILLING,
    ]);
  } catch (error) {
    if (error instanceof TenantAuthError) {
      if (error.code === "UNAUTHENTICATED") {
        redirect("/login?callbackUrl=/platform");
      }
    }

    // Authenticated user lacks platform administration privileges (e.g. hotel staff / hotel owner)
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-surface border border-border rounded-card p-8 shadow-sm text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-danger/10 text-danger flex items-center justify-center mb-4">
            <AlertTriangle size={24} />
          </div>
          <h1 className="text-xl font-bold text-text-primary mb-2">Access Denied</h1>
          <p className="text-sm text-text-secondary mb-6">
            Platform Administration is restricted to verified SaaS platform operators. Hotel management roles
            such as Hotel Owner, Hotel Admin, or Staff do not grant access to multi-tenant platform infrastructure.
          </p>
          <div className="flex flex-col gap-3">
            <Link
              href="/dashboard"
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-control bg-primary-500 text-white font-medium hover:bg-primary-600 transition-colors"
            >
              <ArrowLeft size={16} /> Return to Hotel Workspace
            </Link>
            <Link
              href="/select-hotel"
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-control border border-border text-text-secondary hover:text-text-primary hover:bg-bg transition-colors"
            >
              <Building2 size={16} /> Select Workspace
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const roleLabels: Record<PlatformRole, { label: string; badge: string }> = {
    PLATFORM_SUPER_ADMIN: {
      label: "Platform Super Admin",
      badge: "bg-purple-100 text-purple-800 border-purple-200",
    },
    PLATFORM_SUPPORT: {
      label: "Platform Support",
      badge: "bg-blue-100 text-blue-800 border-blue-200",
    },
    PLATFORM_BILLING: {
      label: "Platform Billing",
      badge: "bg-amber-100 text-amber-800 border-amber-200",
    },
  };

  const roleMeta = roleLabels[admin.platformRole] || {
    label: admin.platformRole,
    badge: "bg-gray-100 text-gray-800 border-gray-200",
  };

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      {/* Platform Header */}
      <header className="h-16 border-b border-border bg-surface sticky top-0 z-20 px-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/platform" className="flex items-center gap-2.5">
            <HotelFlowBrand iconOnly iconClassName="h-8 w-8 rounded-control" />
            <div>
              <span className="font-bold text-base text-text-primary tracking-tight">
                {PRODUCT_NAME} Platform
              </span>
              <span className="text-xs text-text-secondary ml-2 font-mono uppercase">
                Admin Console
              </span>
            </div>
          </Link>

          <span
            className={`text-xs px-2.5 py-0.5 rounded-full border font-semibold ${roleMeta.badge}`}
          >
            {roleMeta.label}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/select-hotel"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-control border border-border text-text-secondary hover:text-text-primary hover:bg-bg transition-colors"
          >
            <Building2 size={14} />
            <span>Hotel Workspaces</span>
          </Link>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-control border border-border text-text-secondary hover:text-text-primary hover:bg-bg transition-colors"
          >
            <ArrowLeft size={14} />
            <span>Active Dashboard</span>
          </Link>
          <Link
            href="/api/auth/signout"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-control text-danger hover:bg-danger/10 transition-colors"
          >
            <LogOut size={14} />
            <span>Sign Out</span>
          </Link>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 md:p-8">{children}</main>
    </div>
  );
}
