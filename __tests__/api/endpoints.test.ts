import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  getTenantFromRoute: vi.fn(),
  requireRole: vi.fn(),
  findGuests: vi.fn(),
  findGuest: vi.fn(),
  updateGuest: vi.fn(),
  findActiveStay: vi.fn(),
}));

vi.mock("next/server", () => {
  class MockNextResponse extends Response {
    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(JSON.stringify(body), {
        ...init,
        headers: { "Content-Type": "application/json", ...init?.headers },
      });
    }
  }
  return { NextResponse: MockNextResponse };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    guest: {
      findMany: mocks.findGuests,
      findUnique: mocks.findGuest,
      update: mocks.updateGuest,
    },
    reservation: { findFirst: mocks.findActiveStay },
  },
}));

vi.mock("@/lib/authz", () => ({
  getTenantFromRoute: mocks.getTenantFromRoute,
  requireModule: async () => null,
  requireRole: mocks.requireRole,
  ROLE_GROUPS: { GUEST_STAYS: ["HOTEL_OWNER", "RECEPTIONIST"] },
}));

import { GET as listGuests } from "@/app/api/guests/route";
import { GET as getGuest, PATCH as updateGuest } from "@/app/api/guests/[id]/route";

const tenant = { hotelId: "hotel-a", userId: "user-a", role: "RECEPTIONIST" };

function guestRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "guest-a1",
    fullName: "Amina Njeri",
    phone: "+254700000001",
    email: "amina@example.test",
    idNumber: null,
    nationality: "Kenyan",
    vehicleRegistration: null,
    notes: null,
    isArchived: false,
    reservations: [],
    folios: [],
    ...overrides,
  };
}

async function json(response: Response) {
  return response.json();
}

describe("guest API route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantFromRoute.mockResolvedValue(tenant);
    mocks.requireRole.mockReturnValue(null);
    mocks.findGuests.mockResolvedValue([]);
    mocks.findGuest.mockResolvedValue(null);
    mocks.updateGuest.mockResolvedValue({ id: "guest-a1", isArchived: true });
    mocks.findActiveStay.mockResolvedValue(null);
  });

  describe("GET /api/guests", () => {
    it("scopes the guest list and latest reservation to the active hotel", async () => {
      const checkInDate = new Date("2026-10-24T12:00:00.000Z");
      mocks.findGuests.mockResolvedValue([
        guestRecord({
          reservations: [
            {
              status: "CHECKED_IN",
              checkInDate,
              checkOutDate: new Date("2026-10-27T10:00:00.000Z"),
              rooms: [{ room: { number: "12" } }],
            },
          ],
        }),
      ]);

      const response = await listGuests(new Request("https://hotel.test/api/guests"));

      expect(response.status).toBe(200);
      expect(await json(response)).toEqual([
        {
          id: "guest-a1",
          fullName: "Amina Njeri",
          phone: "+254700000001",
          email: "amina@example.test",
          isArchived: false,
          currentRoom: "12",
          lastStatus: "CHECKED_IN",
          checkInDate: checkInDate.toISOString(),
          checkOutDate: "2026-10-27T10:00:00.000Z",
        },
      ]);
      expect(mocks.findGuests).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { hotelId: "hotel-a", isArchived: false },
          take: 100,
          include: {
            reservations: expect.objectContaining({
              where: { hotelId: "hotel-a" },
              take: 1,
            }),
          },
        })
      );
    });

    it("applies trimmed search across name, phone, and email", async () => {
      await listGuests(new Request("https://hotel.test/api/guests?q=%20Amina%20"));

      expect(mocks.findGuests).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            hotelId: "hotel-a",
            isArchived: false,
            OR: [
              { fullName: { contains: "Amina", mode: "insensitive" } },
              { phone: { contains: "Amina", mode: "insensitive" } },
              { email: { contains: "Amina", mode: "insensitive" } },
            ],
          },
        })
      );
    });

    it("includes archived guests only when explicitly requested", async () => {
      await listGuests(new Request("https://hotel.test/api/guests?includeArchived=true"));
      expect(mocks.findGuests).toHaveBeenCalledWith(
        expect.objectContaining({ where: { hotelId: "hotel-a", isArchived: undefined } })
      );
    });

    it("rejects unauthenticated requests before querying guest data", async () => {
      mocks.getTenantFromRoute.mockResolvedValue(
        NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 })
      );

      const response = await listGuests(new Request("https://hotel.test/api/guests"));

      expect(response.status).toBe(401);
      expect(mocks.findGuests).not.toHaveBeenCalled();
    });

    it("rejects staff without the guest-stays permission", async () => {
      mocks.requireRole.mockReturnValue(new Response("Forbidden", { status: 403 }));

      const response = await listGuests(new Request("https://hotel.test/api/guests"));

      expect(response.status).toBe(403);
      expect(mocks.findGuests).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/guests/:id", () => {
    it("uses the compound guest and hotel key and returns completed-payment totals", async () => {
      mocks.findGuest.mockResolvedValue(
        guestRecord({
          reservations: [
            {
              id: "reservation-a1",
              code: "R-1001",
              status: "CHECKED_OUT",
              checkInDate: new Date("2026-10-20T12:00:00.000Z"),
              checkOutDate: new Date("2026-10-22T10:00:00.000Z"),
              rooms: [{ room: { number: "12" }, rate: "5000" }],
            },
          ],
          folios: [
            {
              id: "folio-a1",
              isClosed: true,
              items: [{ total: "10000" }, { total: "500" }],
              payments: [{ amount: "6000" }],
            },
          ],
        })
      );

      const response = await getGuest(new Request("https://hotel.test/api/guests/guest-a1"), {
        params: Promise.resolve({ id: "guest-a1" }),
      });

      expect(mocks.findGuest).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id_hotelId: { id: "guest-a1", hotelId: "hotel-a" } } })
      );
      expect(await json(response)).toMatchObject({
        id: "guest-a1",
        reservations: [{ rooms: [{ roomNumber: "12", rate: 5000 }] }],
        folios: [{ id: "folio-a1", total: 10500, paid: 6000, balance: 4500 }],
      });
    });

    it("returns not found for a guest outside the active hotel", async () => {
      const response = await getGuest(new Request("https://hotel.test/api/guests/foreign"), {
        params: Promise.resolve({ id: "guest-from-hotel-b" }),
      });

      expect(response.status).toBe(404);
      expect(await json(response)).toEqual({ error: "Guest not found." });
      expect(mocks.findGuest).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id_hotelId: { id: "guest-from-hotel-b", hotelId: "hotel-a" } } })
      );
    });
  });

  describe("PATCH /api/guests/:id", () => {
    it("blocks archiving a guest with an active stay", async () => {
      mocks.findActiveStay.mockResolvedValue({ id: "active-reservation" });

      const response = await updateGuest(
        new Request("https://hotel.test/api/guests/guest-a1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isArchived: true }),
        }),
        { params: Promise.resolve({ id: "guest-a1" }) }
      );

      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        error: "This guest is currently checked in and can't be archived.",
      });
      expect(mocks.findActiveStay).toHaveBeenCalledWith({
        where: { hotelId: "hotel-a", guestId: "guest-a1", status: "CHECKED_IN" },
      });
      expect(mocks.updateGuest).not.toHaveBeenCalled();
    });

    it("archives only the guest record in the active hotel", async () => {
      mocks.findGuest.mockResolvedValue(guestRecord());

      const response = await updateGuest(
        new Request("https://hotel.test/api/guests/guest-a1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isArchived: true }),
        }),
        { params: Promise.resolve({ id: "guest-a1" }) }
      );

      expect(response.status).toBe(200);
      expect(await json(response)).toEqual({ id: "guest-a1", isArchived: true });
      expect(mocks.updateGuest).toHaveBeenCalledWith({
        where: { id_hotelId: { id: "guest-a1", hotelId: "hotel-a" } },
        data: { isArchived: true },
      });
    });

    it("rejects a non-boolean archive value", async () => {
      const response = await updateGuest(
        new Request("https://hotel.test/api/guests/guest-a1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isArchived: "yes" }),
        }),
        { params: Promise.resolve({ id: "guest-a1" }) }
      );

      expect(response.status).toBe(400);
      expect(mocks.findGuest).not.toHaveBeenCalled();
      expect(mocks.updateGuest).not.toHaveBeenCalled();
    });
  });
});
