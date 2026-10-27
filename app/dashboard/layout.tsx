import { redirect } from "next/navigation";
import { getTenantContext, TenantAuthError } from "@/lib/tenant-context";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let context;
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

  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar userRole={context.role} isPlatformAdmin={context.isPlatformAdmin} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar
          userName={context.hotel.name}
          userRole={context.role}
          isPlatformAdmin={context.isPlatformAdmin}
        />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
