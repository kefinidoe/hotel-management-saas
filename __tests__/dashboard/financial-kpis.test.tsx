import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePageRole: vi.fn(),
  roomCount: vi.fn(),
  reservationCount: vi.fn(),
  paymentAggregate: vi.fn(),
  folioItemAggregate: vi.fn(),
  membershipCount: vi.fn(),
  menuItemCount: vi.fn(),
  context: {
    hotelId: "hotel-a",
    userId: "user-a",
    role: "HOTEL_OWNER" as string,
    hotel: { name: "Hotel A", slug: "hotel-a", currency: "KES", timezone: "Africa/Nairobi" },
  },
  roles: {
    ALL_STAFF: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER", "RECEPTIONIST", "ACCOUNTANT", "HOUSEKEEPER", "WAITER", "CASHIER", "TECHNICIAN"],
    FINANCIAL_REPORTS: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER", "ACCOUNTANT"],
  },
}));

vi.mock("@/lib/page-auth", () => ({ requirePageRole: mocks.requirePageRole }));
vi.mock("@/lib/permissions", () => ({
  ROLE_GROUPS: mocks.roles,
  hasRole: (role: string, allowed: string[]) => allowed.includes(role),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    room: { count: mocks.roomCount },
    reservation: { count: mocks.reservationCount },
    payment: { aggregate: mocks.paymentAggregate },
    folioItem: { aggregate: mocks.folioItemAggregate },
    hotelMembership: { count: mocks.membershipCount },
    menuItem: { count: mocks.menuItemCount },
  },
}));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("lucide-react", () => ({
  BedDouble: () => null,
  Users: () => null,
  Settings: () => null,
  UtensilsCrossed: () => null,
  ArrowRight: () => null,
  CheckCircle2: () => null,
  CalendarRange: () => null,
  Boxes: () => null,
}));

import DashboardPage from "@/app/dashboard/page";

function textContent(node: any): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(" ");
  return textContent(node?.props?.children);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.role = "HOTEL_OWNER";
  mocks.requirePageRole.mockResolvedValue(mocks.context);
  mocks.roomCount.mockResolvedValue(10);
  mocks.reservationCount.mockResolvedValue(2);
  mocks.paymentAggregate.mockResolvedValue({ _sum: { amount: 500 } });
  mocks.folioItemAggregate.mockResolvedValue({ _sum: { total: 900 } });
  mocks.membershipCount.mockResolvedValue(4);
  mocks.menuItemCount.mockResolvedValue(8);
});

describe("dashboard financial KPI authorization", () => {
  it("loads and renders financial aggregates for a permitted role", async () => {
    const page = await DashboardPage();

    expect(mocks.requirePageRole).toHaveBeenCalledWith(mocks.roles.ALL_STAFF, "RESERVATIONS");
    expect(mocks.paymentAggregate).toHaveBeenCalledTimes(2);
    expect(mocks.folioItemAggregate).toHaveBeenCalledOnce();
    expect(textContent(page)).toContain("Today's Revenue");
    expect(textContent(page)).toContain("Outstanding Balance");
    expect(textContent(page)).toContain("KES 500");
    expect(textContent(page)).toContain("KES 400");
  });

  it("does not query or serialize financial aggregates for a receptionist", async () => {
    mocks.context.role = "RECEPTIONIST";

    const page = await DashboardPage();

    expect(mocks.paymentAggregate).not.toHaveBeenCalled();
    expect(mocks.folioItemAggregate).not.toHaveBeenCalled();
    expect(textContent(page)).not.toContain("Today's Revenue");
    expect(textContent(page)).not.toContain("Outstanding Balance");
  });
});
