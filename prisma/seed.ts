/**
 * Multi-Tenant SaaS Seed Script.
 *
 * Populates ONLY fictional demo data:
 *   - Demo Hotel Alpha (with Room 101, Room 102, staff, guest, reservation, inventory)
 *   - Demo Hotel Beta (with Room 101, Room 102, staff, guest, reservation, inventory)
 *
 * Notice: Identical room numbers (101, 102) and SKUs (ING-COFFEE-01) prove tenant-scoped uniqueness!
 * Zero production data is used.
 */

import { PrismaClient, HotelRole, PlatformRole, RoomStatus, ReservationStatus, BookingSource, FolioItemType, PaymentStatus } from "@prisma/client";
import bcrypt from "bcryptjs";
import { assertDatabaseSafety } from "../lib/db-safety-guard";

const prisma = new PrismaClient();

export async function seedMultiTenantData(db: PrismaClient) {
  const defaultPasswordHash = await bcrypt.hash("Password123!", 10);

  console.log("Seeding Platform Super Admin...");
  const platformAdmin = await db.user.upsert({
    where: { email: "platform-admin@example.com" },
    update: {},
    create: {
      name: "SaaS Platform Admin",
      email: "platform-admin@example.com",
      passwordHash: defaultPasswordHash,
      platformRole: PlatformRole.PLATFORM_SUPER_ADMIN,
    },
  });

  // -------------------------------------------------------------------------
  // 1. DEMO HOTEL ALPHA
  // -------------------------------------------------------------------------
  console.log("Seeding Demo Hotel Alpha...");
  const hotelAlpha = await db.hotel.upsert({
    where: { slug: "demo-hotel-alpha" },
    update: {},
    create: {
      name: "Demo Hotel Alpha",
      slug: "demo-hotel-alpha",
      currency: "USD",
      timezone: "America/New_York",
      address: "100 Alpha Way, New York, NY",
      phone: "+1-555-0101",
      email: "info@hotelalpha.example.com",
      status: "ACTIVE",
    },
  });

  const alphaOwner = await db.user.upsert({
    where: { email: "alpha-owner@example.com" },
    update: {},
    create: {
      name: "Alice Owner",
      email: "alpha-owner@example.com",
      passwordHash: defaultPasswordHash,
      department: "Management",
    },
  });

  const alphaReceptionist = await db.user.upsert({
    where: { email: "alpha-receptionist@example.com" },
    update: {},
    create: {
      name: "Alex FrontDesk",
      email: "alpha-receptionist@example.com",
      passwordHash: defaultPasswordHash,
      department: "Front Desk",
    },
  });

  await db.hotelMembership.upsert({
    where: { userId_hotelId: { userId: alphaOwner.id, hotelId: hotelAlpha.id } },
    update: {},
    create: {
      userId: alphaOwner.id,
      hotelId: hotelAlpha.id,
      role: HotelRole.HOTEL_OWNER,
    },
  });

  await db.hotelMembership.upsert({
    where: { userId_hotelId: { userId: alphaReceptionist.id, hotelId: hotelAlpha.id } },
    update: {},
    create: {
      userId: alphaReceptionist.id,
      hotelId: hotelAlpha.id,
      role: HotelRole.RECEPTIONIST,
    },
  });

  const alphaDeluxeType = await db.roomType.create({
    data: {
      hotelId: hotelAlpha.id,
      name: "Deluxe King",
      baseRate: 150.0,
      capacity: 2,
    },
  });

  const alphaRoom101 = await db.room.create({
    data: {
      hotelId: hotelAlpha.id,
      number: "101",
      floor: "1",
      roomTypeId: alphaDeluxeType.id,
      status: RoomStatus.RESERVED,
    },
  });

  const alphaRoom102 = await db.room.create({
    data: {
      hotelId: hotelAlpha.id,
      number: "102",
      floor: "1",
      roomTypeId: alphaDeluxeType.id,
      status: RoomStatus.AVAILABLE,
    },
  });

  const alphaGuest = await db.guest.create({
    data: {
      hotelId: hotelAlpha.id,
      fullName: "John Doe",
      email: "john.doe@example.com",
      phone: "+1-555-0202",
    },
  });

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const alphaReservation = await db.reservation.create({
    data: {
      hotelId: hotelAlpha.id,
      code: "RES-ALPHA-101",
      guestId: alphaGuest.id,
      createdById: alphaReceptionist.id,
      checkInDate: today,
      checkOutDate: tomorrow,
      status: ReservationStatus.CONFIRMED,
      source: BookingSource.WALK_IN,
      rooms: {
        create: [
          {
            roomId: alphaRoom101.id,
            rate: 150.0,
          },
        ],
      },
    },
  });

  const alphaFolio = await db.folio.create({
    data: {
      hotelId: hotelAlpha.id,
      guestId: alphaGuest.id,
      reservationId: alphaReservation.id,
    },
  });

  await db.folioItem.create({
    data: {
      folioId: alphaFolio.id,
      type: FolioItemType.ROOM_CHARGE,
      description: "Room 101 - Nightly Stay",
      quantity: 1,
      unitPrice: 150.0,
      total: 150.0,
    },
  });

  const alphaCashMethod = await db.paymentMethod.create({
    data: {
      hotelId: hotelAlpha.id,
      name: "Cash",
    },
  });

  await db.payment.create({
    data: {
      hotelId: hotelAlpha.id,
      folioId: alphaFolio.id,
      paymentMethodId: alphaCashMethod.id,
      cashierId: alphaReceptionist.id,
      amount: 150.0,
      status: PaymentStatus.COMPLETED,
    },
  });

  await db.inventoryItem.create({
    data: {
      hotelId: hotelAlpha.id,
      sku: "ING-COFFEE-01",
      name: "House Blend Coffee Beans",
      category: "Beverages",
      unit: "g",
      currentStock: 5000,
      reorderLevel: 1000,
      costPerUnit: 0.05,
    },
  });

  // -------------------------------------------------------------------------
  // 2. DEMO HOTEL BETA
  // -------------------------------------------------------------------------
  console.log("Seeding Demo Hotel Beta...");
  const hotelBeta = await db.hotel.upsert({
    where: { slug: "demo-hotel-beta" },
    update: {},
    create: {
      name: "Demo Hotel Beta",
      slug: "demo-hotel-beta",
      currency: "EUR",
      timezone: "Europe/Paris",
      address: "200 Boulevard Beta, Paris, France",
      phone: "+33-1-555-0102",
      email: "info@hotelbeta.example.com",
      status: "ACTIVE",
    },
  });

  const betaOwner = await db.user.upsert({
    where: { email: "beta-owner@example.com" },
    update: {},
    create: {
      name: "Bernard Owner",
      email: "beta-owner@example.com",
      passwordHash: defaultPasswordHash,
      department: "Executive",
    },
  });

  const betaReceptionist = await db.user.upsert({
    where: { email: "beta-receptionist@example.com" },
    update: {},
    create: {
      name: "Brigitte Desk",
      email: "beta-receptionist@example.com",
      passwordHash: defaultPasswordHash,
      department: "Reception",
    },
  });

  await db.hotelMembership.upsert({
    where: { userId_hotelId: { userId: betaOwner.id, hotelId: hotelBeta.id } },
    update: {},
    create: {
      userId: betaOwner.id,
      hotelId: hotelBeta.id,
      role: HotelRole.HOTEL_OWNER,
    },
  });

  await db.hotelMembership.upsert({
    where: { userId_hotelId: { userId: betaReceptionist.id, hotelId: hotelBeta.id } },
    update: {},
    create: {
      userId: betaReceptionist.id,
      hotelId: hotelBeta.id,
      role: HotelRole.RECEPTIONIST,
    },
  });

  const betaSuiteType = await db.roomType.create({
    data: {
      hotelId: hotelBeta.id,
      name: "Executive Suite",
      baseRate: 220.0,
      capacity: 3,
    },
  });

  // Identical room numbers 101 and 102 in Hotel Beta!
  const betaRoom101 = await db.room.create({
    data: {
      hotelId: hotelBeta.id,
      number: "101",
      floor: "1",
      roomTypeId: betaSuiteType.id,
      status: RoomStatus.RESERVED,
    },
  });

  const betaRoom102 = await db.room.create({
    data: {
      hotelId: hotelBeta.id,
      number: "102",
      floor: "1",
      roomTypeId: betaSuiteType.id,
      status: RoomStatus.AVAILABLE,
    },
  });

  const betaGuest = await db.guest.create({
    data: {
      hotelId: hotelBeta.id,
      fullName: "Jane Smith",
      email: "jane.smith@example.com",
      phone: "+33-1-555-0303",
    },
  });

  const betaReservation = await db.reservation.create({
    data: {
      hotelId: hotelBeta.id,
      code: "RES-BETA-101",
      guestId: betaGuest.id,
      createdById: betaReceptionist.id,
      checkInDate: today,
      checkOutDate: tomorrow,
      status: ReservationStatus.CONFIRMED,
      source: BookingSource.OTA,
      rooms: {
        create: [
          {
            roomId: betaRoom101.id,
            rate: 220.0,
          },
        ],
      },
    },
  });

  const betaFolio = await db.folio.create({
    data: {
      hotelId: hotelBeta.id,
      guestId: betaGuest.id,
      reservationId: betaReservation.id,
    },
  });

  await db.folioItem.create({
    data: {
      folioId: betaFolio.id,
      type: FolioItemType.ROOM_CHARGE,
      description: "Suite 101 - European Stay",
      quantity: 1,
      unitPrice: 220.0,
      total: 220.0,
    },
  });

  const betaCashMethod = await db.paymentMethod.create({
    data: {
      hotelId: hotelBeta.id,
      name: "Cash",
    },
  });

  await db.payment.create({
    data: {
      hotelId: hotelBeta.id,
      folioId: betaFolio.id,
      paymentMethodId: betaCashMethod.id,
      cashierId: betaReceptionist.id,
      amount: 220.0,
      status: PaymentStatus.COMPLETED,
    },
  });

  // Identical SKU in Hotel Beta!
  await db.inventoryItem.create({
    data: {
      hotelId: hotelBeta.id,
      sku: "ING-COFFEE-01",
      name: "Artisan Dark Roast Beans",
      category: "Beverages",
      unit: "g",
      currentStock: 3000,
      reorderLevel: 500,
      costPerUnit: 0.08,
    },
  });

  console.log("Seeding completed successfully.");
}

async function main() {
  assertDatabaseSafety();
  await seedMultiTenantData(prisma);
}

if (process.env.NODE_ENV !== "test") {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
