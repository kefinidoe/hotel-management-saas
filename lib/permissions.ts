import { HotelRole } from "@prisma/client";

// Pure permission data shared by server routes and client navigation.
// Keep this file free of database/auth imports so it is safe in client code.
export const ROLE_GROUPS = {
  ALL_STAFF: [
    HotelRole.HOTEL_OWNER,
    HotelRole.HOTEL_ADMIN,
    HotelRole.MANAGER,
    HotelRole.RECEPTIONIST,
    HotelRole.ACCOUNTANT,
    HotelRole.HOUSEKEEPER,
    HotelRole.WAITER,
    HotelRole.CASHIER,
    HotelRole.TECHNICIAN,
  ],
  MANAGEMENT: [
    HotelRole.HOTEL_OWNER,
    HotelRole.HOTEL_ADMIN,
    HotelRole.MANAGER,
  ],
  GUEST_STAYS: [
    HotelRole.HOTEL_OWNER,
    HotelRole.HOTEL_ADMIN,
    HotelRole.MANAGER,
    HotelRole.RECEPTIONIST,
  ],
  FRONT_DESK: [
    HotelRole.HOTEL_OWNER,
    HotelRole.HOTEL_ADMIN,
    HotelRole.MANAGER,
    HotelRole.RECEPTIONIST,
    HotelRole.CASHIER,
  ],
  ACCOMMODATION_PAYMENTS: [
    HotelRole.HOTEL_OWNER,
    HotelRole.HOTEL_ADMIN,
    HotelRole.MANAGER,
    HotelRole.RECEPTIONIST,
    HotelRole.CASHIER,
  ],
  PAYMENT_OPERATIONS: [
    HotelRole.HOTEL_OWNER,
    HotelRole.HOTEL_ADMIN,
    HotelRole.MANAGER,
    HotelRole.RECEPTIONIST,
    HotelRole.WAITER,
    HotelRole.CASHIER,
  ],
  RESTAURANT_POS: [
    HotelRole.HOTEL_OWNER,
    HotelRole.HOTEL_ADMIN,
    HotelRole.MANAGER,
    HotelRole.WAITER,
    HotelRole.CASHIER,
  ],
  HOUSEKEEPING: [
    HotelRole.HOTEL_OWNER,
    HotelRole.HOTEL_ADMIN,
    HotelRole.MANAGER,
    HotelRole.HOUSEKEEPER,
  ],
  MAINTENANCE: [
    HotelRole.HOTEL_OWNER,
    HotelRole.HOTEL_ADMIN,
    HotelRole.MANAGER,
    HotelRole.TECHNICIAN,
  ],
  FINANCIAL_REPORTS: [
    HotelRole.HOTEL_OWNER,
    HotelRole.HOTEL_ADMIN,
    HotelRole.MANAGER,
    HotelRole.ACCOUNTANT,
  ],
  STAFF_VIEW: [
    HotelRole.HOTEL_OWNER,
    HotelRole.HOTEL_ADMIN,
    HotelRole.MANAGER,
  ],
  STAFF_ADMIN: [
    HotelRole.HOTEL_OWNER,
    HotelRole.HOTEL_ADMIN,
  ],
} satisfies Record<string, HotelRole[]>;

export function hasRole(role: HotelRole, allowed: readonly HotelRole[]): boolean {
  return allowed.includes(role);
}
