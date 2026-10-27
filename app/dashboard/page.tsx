import { prisma } from "@/lib/prisma";
import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";
import Link from "next/link";
import {
  BedDouble,
  Users,
  Settings,
  UtensilsCrossed,
  ArrowRight,
  CheckCircle2,
  CalendarRange,
  Boxes,
} from "lucide-react";

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfToday() {
  const d = startOfToday();
  d.setDate(d.getDate() + 1);
  return d;
}

export default async function DashboardPage() {
  const context = await requirePageRole(ROLE_GROUPS.ALL_STAFF, "RESERVATIONS");
  const canViewFinancials = ROLE_GROUPS.FINANCIAL_REPORTS.includes(context.role);
  const hotelId = context.hotelId;
  const currencySymbol = context.hotel.currency || "KES";

  const todayStart = startOfToday();
  const todayEnd = endOfToday();

  const [
    totalRooms,
    occupiedRooms,
    availableRooms,
    arrivalsToday,
    departuresToday,
    revenueAgg,
    allItemsAgg,
    allPaymentsAgg,
    staffCount,
    menuItemsCount,
  ] = await Promise.all([
    prisma.room.count({ where: { hotelId, isActive: true } }),
    prisma.room.count({ where: { hotelId, isActive: true, status: "OCCUPIED" } }),
    prisma.room.count({ where: { hotelId, isActive: true, status: "AVAILABLE" } }),
    prisma.reservation.count({
      where: {
        hotelId,
        checkInDate: { gte: todayStart, lt: todayEnd },
        status: { in: ["CONFIRMED", "PENDING"] },
      },
    }),
    prisma.reservation.count({
      where: {
        hotelId,
        checkOutDate: { gte: todayStart, lt: todayEnd },
        status: "CHECKED_IN",
      },
    }),
    canViewFinancials
      ? prisma.payment.aggregate({
          _sum: { amount: true },
          where: {
            hotelId,
            createdAt: { gte: todayStart, lt: todayEnd },
            status: "COMPLETED",
          },
        })
      : Promise.resolve({ _sum: { amount: null } }),
    canViewFinancials
      ? prisma.folioItem.aggregate({
          _sum: { total: true },
          where: { folio: { hotelId } },
        })
      : Promise.resolve({ _sum: { total: null } }),
    canViewFinancials
      ? prisma.payment.aggregate({
          _sum: { amount: true },
          where: { hotelId, status: "COMPLETED" },
        })
      : Promise.resolve({ _sum: { amount: null } }),
    prisma.hotelMembership.count({
      where: { hotelId, status: "ACTIVE" },
    }),
    prisma.menuItem.count({
      where: { hotelId, isActive: true },
    }),
  ]);

  const todaysRevenue = Number(revenueAgg._sum.amount ?? 0);
  const outstandingBalance = Math.max(
    0,
    Number(allItemsAgg._sum.total ?? 0) - Number(allPaymentsAgg._sum.amount ?? 0)
  );
  const occupancyPct = totalRooms > 0 ? Math.round((occupiedRooms / totalRooms) * 100) : 0;

  const kpis = [
    { label: "Occupancy", value: `${occupancyPct}%`, sub: `${occupiedRooms} of ${totalRooms} rooms occupied` },
    ...(canViewFinancials
      ? [
          { label: "Today's Revenue", value: `${currencySymbol} ${todaysRevenue.toLocaleString()}`, sub: "Payments received today" },
        ]
      : []),
    { label: "Available Rooms", value: String(availableRooms), sub: `of ${totalRooms} total` },
    { label: "Arrivals", value: String(arrivalsToday), sub: "expected today" },
    { label: "Departures", value: String(departuresToday), sub: "expected today" },
    ...(canViewFinancials
      ? [
          { label: "Outstanding Balance", value: `${currencySymbol} ${outstandingBalance.toLocaleString()}`, sub: "across all unpaid folios" },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Overview — {context.hotel.name}</h1>
          <p className="text-text-secondary text-sm mt-0.5">
            Active workspace: <span className="font-mono text-xs font-semibold text-text-primary">@{context.hotel.slug}</span> ({context.hotel.timezone})
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/dashboard/settings"
            className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5 rounded-lg"
          >
            <Settings size={14} /> Property Settings
          </Link>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="card shadow-sm border border-border">
            <p className="text-sm text-text-secondary">{kpi.label}</p>
            <p className="kpi-value mt-1 text-2xl font-bold text-text-primary">{kpi.value}</p>
            <p className="text-xs text-text-muted mt-1">{kpi.sub}</p>
          </div>
        ))}
      </div>

      {/* Empty-state / Onboarding Checklist when Hotel has no rooms */}
      {totalRooms === 0 && (
        <div className="card border-2 border-primary-200 bg-primary-50/20 p-6 rounded-2xl shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-primary-100 text-primary-800 mb-2">
                <CheckCircle2 size={13} /> Hotel Workspace Initialized
              </span>
              <h2 className="text-lg font-bold text-text-primary">
                Welcome to your new hotel workspace!
              </h2>
              <p className="text-text-secondary text-sm mt-1 max-w-2xl">
                Your hotel database and operational schema are fully set up. Follow the checklist below to complete your property setup and start checking in guests.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-6">
            {/* Step 1: Rooms */}
            <div className="p-4 rounded-xl border border-border bg-surface flex flex-col justify-between">
              <div>
                <div className="w-9 h-9 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center mb-3">
                  <BedDouble size={18} />
                </div>
                <h3 className="font-semibold text-sm text-text-primary">1. Rooms & Tariffs</h3>
                <p className="text-xs text-text-secondary mt-1">
                  Add your room types (e.g. Standard, Deluxe) and inventory room numbers.
                </p>
              </div>
              <Link
                href="/dashboard/rooms"
                className="mt-4 text-xs font-semibold text-primary-600 hover:text-primary-700 flex items-center gap-1 group"
              >
                Configure Rooms <ArrowRight size={13} className="group-hover:translate-x-0.5 transition-transform" />
              </Link>
            </div>

            {/* Step 2: Staff */}
            <div className="p-4 rounded-xl border border-border bg-surface flex flex-col justify-between">
              <div>
                <div className="w-9 h-9 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center mb-3">
                  <Users size={18} />
                </div>
                <h3 className="font-semibold text-sm text-text-primary">2. Team & Staff</h3>
                <p className="text-xs text-text-secondary mt-1">
                  {staffCount === 1
                    ? "Currently 1 member (you). Add receptionists, cashiers, and managers."
                    : `${staffCount} active staff members in this hotel workspace.`}
                </p>
              </div>
              <Link
                href="/dashboard/staff"
                className="mt-4 text-xs font-semibold text-primary-600 hover:text-primary-700 flex items-center gap-1 group"
              >
                Manage Staff <ArrowRight size={13} className="group-hover:translate-x-0.5 transition-transform" />
              </Link>
            </div>

            {/* Step 3: Restaurant / POS */}
            <div className="p-4 rounded-xl border border-border bg-surface flex flex-col justify-between">
              <div>
                <div className="w-9 h-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center mb-3">
                  <UtensilsCrossed size={18} />
                </div>
                <h3 className="font-semibold text-sm text-text-primary">3. Restaurant & POS</h3>
                <p className="text-xs text-text-secondary mt-1">
                  {menuItemsCount === 0
                    ? "Set up food, beverages, and counter menus for direct or room billing."
                    : `${menuItemsCount} menu items configured in this hotel.`}
                </p>
              </div>
              <Link
                href="/dashboard/restaurant"
                className="mt-4 text-xs font-semibold text-primary-600 hover:text-primary-700 flex items-center gap-1 group"
              >
                Set Up Menu <ArrowRight size={13} className="group-hover:translate-x-0.5 transition-transform" />
              </Link>
            </div>

            {/* Step 4: Settings */}
            <div className="p-4 rounded-xl border border-border bg-surface flex flex-col justify-between">
              <div>
                <div className="w-9 h-9 rounded-lg bg-purple-100 text-purple-700 flex items-center justify-center mb-3">
                  <Settings size={18} />
                </div>
                <h3 className="font-semibold text-sm text-text-primary">4. Property Details</h3>
                <p className="text-xs text-text-secondary mt-1">
                  Update contact phone, billing address, base currency, and timezones.
                </p>
              </div>
              <Link
                href="/dashboard/settings"
                className="mt-4 text-xs font-semibold text-primary-600 hover:text-primary-700 flex items-center gap-1 group"
              >
                Hotel Settings <ArrowRight size={13} className="group-hover:translate-x-0.5 transition-transform" />
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
