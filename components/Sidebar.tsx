"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { HotelRole } from "@prisma/client";
import {
  LayoutDashboard,
  CalendarRange,
  BedDouble,
  Users,
  Contact,
  Sparkles,
  UtensilsCrossed,
  Boxes,
  Wrench,
  Receipt,
  BarChart3,
  UserCog,
  Settings,
  CreditCard,
  ChevronsLeft,
  ChevronsRight,
  Shield,
} from "lucide-react";
import clsx from "clsx";
import { hasRole, ROLE_GROUPS } from "@/lib/permissions";

type NavItem = {
  label: string;
  href: string;
  icon: React.ElementType;
  roles: readonly HotelRole[];
};
type NavGroup = { title: string; items: NavItem[] };

const NAV: NavGroup[] = [
  {
    title: "Overview",
    items: [
      {
        label: "Dashboard",
        href: "/dashboard",
        icon: LayoutDashboard,
        roles: ROLE_GROUPS.ALL_STAFF,
      },
    ],
  },
  {
    title: "Operations",
    items: [
      { label: "Front Desk", href: "/dashboard/front-desk", icon: Users, roles: ROLE_GROUPS.FRONT_DESK },
      { label: "Reservations", href: "/dashboard/reservations", icon: CalendarRange, roles: ROLE_GROUPS.GUEST_STAYS },
      { label: "Rooms", href: "/dashboard/rooms", icon: BedDouble, roles: ROLE_GROUPS.ALL_STAFF },
      { label: "Guests", href: "/dashboard/guests", icon: Contact, roles: ROLE_GROUPS.GUEST_STAYS },
      { label: "Housekeeping", href: "/dashboard/housekeeping", icon: Sparkles, roles: ROLE_GROUPS.HOUSEKEEPING },
      { label: "Maintenance", href: "/dashboard/maintenance", icon: Wrench, roles: ROLE_GROUPS.MAINTENANCE },
    ],
  },
  {
    title: "Revenue",
    items: [
      { label: "Restaurant", href: "/dashboard/restaurant", icon: UtensilsCrossed, roles: ROLE_GROUPS.RESTAURANT_POS },
      { label: "Inventory", href: "/dashboard/inventory", icon: Boxes, roles: ROLE_GROUPS.MANAGEMENT },
      { label: "Expenses", href: "/dashboard/expenses", icon: Receipt, roles: ROLE_GROUPS.ALL_STAFF },
      { label: "Reports", href: "/dashboard/reports", icon: BarChart3, roles: ROLE_GROUPS.FINANCIAL_REPORTS },
    ],
  },
  {
    title: "Administration",
    items: [
      { label: "Staff", href: "/dashboard/staff", icon: UserCog, roles: ROLE_GROUPS.STAFF_VIEW },
      { label: "Subscription", href: "/dashboard/subscription", icon: CreditCard, roles: ROLE_GROUPS.STAFF_ADMIN },
      { label: "Settings", href: "/dashboard/settings", icon: Settings, roles: ROLE_GROUPS.STAFF_ADMIN },
    ],
  },
];

export default function Sidebar({
  userRole,
  isPlatformAdmin = false,
}: {
  userRole: HotelRole;
  isPlatformAdmin?: boolean;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  const visibleGroups = NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => hasRole(userRole, item.roles)),
  })).filter((group) => group.items.length > 0);

  return (
    <aside
      className={clsx(
        "h-screen sticky top-0 flex flex-col border-r border-sidebar-border bg-sidebar-bg transition-all",
        collapsed ? "w-[76px]" : "w-64"
      )}
    >
      <div
        className={clsx(
          "flex items-center justify-center border-b border-sidebar-border transition-all",
          collapsed ? "h-20 px-2" : "h-28 px-3"
        )}
      >
        <Link
          href="/dashboard"
          className="flex w-full items-center justify-center"
          aria-label="Axis Hotel dashboard"
        >
          <Image
            src="/axis-hotel-mark.png"
            alt="Axis Hotel Nakuru"
            width={302}
            height={312}
            priority
            className={clsx(
              "h-auto shrink-0 object-contain",
              collapsed ? "w-14" : "w-24"
            )}
          />
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-6">
        {visibleGroups.map((group) => (
          <div key={group.title}>
            {!collapsed && (
              <p className="px-3 mb-1.5 text-xs font-medium uppercase tracking-wide text-sidebar-textMuted">
                {group.title}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = pathname === item.href;
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    title={collapsed ? item.label : undefined}
                    className={clsx(
                      "flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium transition-colors border-l-2",
                      active
                        ? "bg-white/10 text-sidebar-active border-sidebar-active"
                        : "text-sidebar-textMuted border-transparent hover:bg-sidebar-hover hover:text-sidebar-text"
                    )}
                  >
                    <Icon size={18} strokeWidth={1.8} className="shrink-0" />
                    {!collapsed && <span>{item.label}</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {isPlatformAdmin && (
        <div className="px-2 pb-2">
          <Link
            href="/platform"
            title={collapsed ? "Platform Admin" : undefined}
            className={clsx(
              "flex items-center gap-3 rounded-control px-3 py-2 text-sm font-semibold transition-colors border-l-2",
              pathname.startsWith("/platform")
                ? "bg-purple-900/40 text-purple-300 border-purple-400"
                : "text-purple-300/80 border-transparent hover:bg-purple-900/20 hover:text-purple-200"
            )}
          >
            <Shield size={18} strokeWidth={2} className="shrink-0 text-purple-400" />
            {!collapsed && <span>Platform Admin</span>}
          </Link>
        </div>
      )}

      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-2 px-4 py-3 border-t border-sidebar-border text-sidebar-textMuted
                   hover:text-sidebar-text text-sm"
      >
        {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
        {!collapsed && <span>Collapse</span>}
      </button>
    </aside>
  );
}
