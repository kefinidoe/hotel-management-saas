import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkModuleEntitlement: vi.fn(),
  getOrBootstrapSubscription: vi.fn(),
  getTenantContext: vi.fn(),
  getBillingTenantContext: vi.fn(),
  redirect: vi.fn((location: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as any).location = location;
    throw error;
  }),
  TenantAuthError: class extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  context: {
    hotelId: "hotel-a",
    userId: "user-a",
    role: "HOTEL_ADMIN" as string,
    hotel: { id: "hotel-a", status: "SUSPENDED" },
  },
}));

vi.mock("@prisma/client", () => ({
  HotelRole: {
    HOTEL_OWNER: "HOTEL_OWNER",
    HOTEL_ADMIN: "HOTEL_ADMIN",
    MANAGER: "MANAGER",
    RECEPTIONIST: "RECEPTIONIST",
    ACCOUNTANT: "ACCOUNTANT",
  },
  PlatformRole: {
    PLATFORM_SUPER_ADMIN: "PLATFORM_SUPER_ADMIN",
    PLATFORM_SUPPORT: "PLATFORM_SUPPORT",
    PLATFORM_BILLING: "PLATFORM_BILLING",
  },
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/tenant-context", () => ({
  getTenantContext: mocks.getTenantContext,
  getBillingTenantContext: mocks.getBillingTenantContext,
  requirePlatformRole: vi.fn(),
  TenantAuthError: mocks.TenantAuthError,
}));
vi.mock("@/lib/permissions", () => ({
  hasRole: (role: string, allowed: string[]) => allowed.includes(role),
}));
vi.mock("@/lib/entitlements", () => ({
  checkModuleEntitlement: mocks.checkModuleEntitlement,
  getOrBootstrapSubscription: mocks.getOrBootstrapSubscription,
}));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: vi.fn() } } }));

import { requireBillingPageRole, requirePageRole } from "@/lib/page-auth";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.role = "HOTEL_ADMIN";
  mocks.getTenantContext.mockResolvedValue(mocks.context);
  mocks.getBillingTenantContext.mockResolvedValue(mocks.context);
  mocks.checkModuleEntitlement.mockResolvedValue({ allowed: true });
  mocks.getOrBootstrapSubscription.mockResolvedValue({ effectiveStatus: "ACTIVE", isOperational: true });
});

describe("server-rendered subscription authorization", () => {
  it("checks the module entitlement before returning the tenant context", async () => {
    await expect(requirePageRole(["HOTEL_ADMIN"] as any, "INVENTORY")).resolves.toBe(mocks.context);
    expect(mocks.checkModuleEntitlement).toHaveBeenCalledWith("hotel-a", "INVENTORY", "read");
  });

  it("redirects denied operational pages to subscription recovery", async () => {
    mocks.checkModuleEntitlement.mockResolvedValue({ allowed: false, code: "TRIAL_EXPIRED" });

    await expect(requirePageRole(["HOTEL_ADMIN"] as any, "RESERVATIONS")).rejects.toMatchObject({
      location: "/dashboard/subscription?error=TRIAL_EXPIRED",
    });
  });

  it("fails closed to the recovery page when entitlement state is unavailable", async () => {
    mocks.checkModuleEntitlement.mockRejectedValue(new Error("database unavailable"));

    await expect(requirePageRole(["HOTEL_ADMIN"] as any, "RESERVATIONS")).rejects.toMatchObject({
      location: "/dashboard/subscription?error=SUBSCRIPTION_STATUS_UNAVAILABLE",
    });
  });

  it("redirects suspended hotel operations to the recovery surface instead of logging out", async () => {
    mocks.getTenantContext.mockRejectedValue(new mocks.TenantAuthError("HOTEL_SUSPENDED"));

    await expect(requirePageRole(["HOTEL_ADMIN"] as any, "RESERVATIONS")).rejects.toMatchObject({
      location: "/dashboard/subscription?error=HOTEL_SUSPENDED",
    });
  });

  it.each(["TRIAL_EXPIRED", "PAST_DUE"])("allows read-only pages when %s", async (status) => {
    mocks.getOrBootstrapSubscription.mockResolvedValue({ effectiveStatus: status, isOperational: false });
    await expect(requirePageRole(["HOTEL_ADMIN"] as any, "RESERVATIONS")).resolves.toBe(mocks.context);
    expect(mocks.checkModuleEntitlement).toHaveBeenCalledWith("hotel-a", "RESERVATIONS", "read");
  });

  it("sends a sole suspended hotel without a selection to billing rather than onboarding", async () => {
    mocks.getTenantContext.mockRejectedValue(new mocks.TenantAuthError("NO_ACTIVE_MEMBERSHIP"));
    await expect(requirePageRole(["HOTEL_ADMIN"] as any)).rejects.toMatchObject({ location: "/dashboard/subscription?error=HOTEL_SUSPENDED" });
  });

  it("blocks even pages without a module when the subscription is suspended", async () => {
    mocks.getOrBootstrapSubscription.mockResolvedValue({ effectiveStatus: "SUSPENDED", isOperational: false });
    await expect(requirePageRole(["HOTEL_ADMIN"] as any)).rejects.toMatchObject({ location: "/dashboard/subscription?error=SUBSCRIPTION_SUSPENDED" });
  });

  it("keeps the billing recovery context available without checking operational entitlement", async () => {
    await expect(requireBillingPageRole(["HOTEL_ADMIN"] as any)).resolves.toBe(mocks.context);
    expect(mocks.getBillingTenantContext).toHaveBeenCalledOnce();
    expect(mocks.checkModuleEntitlement).not.toHaveBeenCalled();
  });

  it("checks role authorization before module entitlement", async () => {
    mocks.context.role = "RECEPTIONIST";

    await expect(requirePageRole(["HOTEL_ADMIN"] as any, "REPORTS")).rejects.toMatchObject({
      location: "/dashboard",
    });
    expect(mocks.checkModuleEntitlement).not.toHaveBeenCalled();
  });
});
