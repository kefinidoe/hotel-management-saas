/**
 * Owner acceptance-testing demo data.
 *
 * Creates two complete, self-contained hotels with a staff account for every
 * role the owner needs to test, plus enough live business data that each screen
 * has something real on it:
 *
 *   Riverside Grand Hotel  (Nakuru)   - PROFESSIONAL plan, full house tonight
 *   Lakeview Lodge         (Naivasha) - STARTER plan, different staff and data
 *
 * Everything here is fictional. The script refuses to run against anything but a
 * loopback PostgreSQL server holding a database named `hotel_saas_demo_*`, and it
 * never touches an existing database's rows: it is meant to be run against the
 * dedicated demo database that `scripts/owner-test-env.mjs` creates and resets.
 *
 * Credentials are generated per run and written to `.owner-test/credentials.json`
 * (git-ignored). They are never printed to a committed file.
 *
 *   node scripts/owner-test-env.mjs reset     # drop, migrate, seed  (preferred)
 *   SAAS_DEMO_INITIAL_PASSWORD=... npx tsx scripts/owner-test/seed-demo.ts
 */

import { PrismaClient, type HotelRole, type Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePassword } from "../../lib/password";
import { assertLocalDemoSeedTarget } from "../local-demo-seed-safety";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const prisma = new PrismaClient();

const PASSWORD = (() => {
  const supplied = process.env.SAAS_DEMO_INITIAL_PASSWORD;
  if (supplied && supplied.length >= 16) return supplied;
  // One strong password per run for every demo account. Separate passwords would
  // be better practice, but this set exists to be typed by hand at a login
  // screen during acceptance testing, and it never guards real data.
  return generatePassword(16);
})();

/** Day boundaries are dates at local midnight, which is how the app stores them. */
function daysFromToday(offset: number): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date;
}

function code(prefix: string, n: number): string {
  return `${prefix}-${new Date().getFullYear()}-${String(n).padStart(5, "0")}`;
}

const CREDENTIALS: Array<{
  hotel: string;
  role: string;
  name: string;
  email: string;
}> = [];

async function main() {
  assertLocalDemoSeedTarget();

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const platformAdmin = await prisma.user.upsert({
    where: { email: "platform@demo.test" },
    update: { passwordHash },
    create: {
      name: "Demo Platform Admin",
      email: "platform@demo.test",
      passwordHash,
      platformRole: "PLATFORM_SUPER_ADMIN",
    },
  });
  CREDENTIALS.push({
    hotel: "(platform)",
    role: "PLATFORM_SUPER_ADMIN",
    name: platformAdmin.name,
    email: platformAdmin.email,
  });

  const riverside = await seedHotel({
    passwordHash,
    name: "Riverside Grand Hotel",
    slug: "riverside-grand",
    email: "frontdesk@riverside-grand.demo",
    phone: "+254 700 000 101",
    address: "Kenyatta Avenue, Nakuru",
    planId: "PROFESSIONAL",
    roomRates: { single: 6500, double: 9500, twin: 9000 },
    rooms: [
      ["101", "1", "Single"],
      ["102", "1", "Single"],
      ["103", "1", "Double"],
      ["104", "1", "Double"],
      ["201", "2", "Double"],
      ["202", "2", "Twin"],
      ["203", "2", "Double"],
      ["301", "3", "Twin"],
    ],
    staff: [
      ["HOTEL_OWNER", "Grace Wanjiku", "owner"],
      ["HOTEL_ADMIN", "Peter Kariuki", "admin"],
      ["MANAGER", "Naomi Chebet", "manager"],
      ["RECEPTIONIST", "Brian Otieno", "receptionist"],
      ["ACCOUNTANT", "Faith Njeri", "accountant"],
      ["WAITER", "Kevin Mwangi", "waiter"],
      ["CASHIER", "Lucy Achieng", "cashier"],
      ["HOUSEKEEPER", "Janet Wairimu", "housekeeping"],
      ["TECHNICIAN", "Samuel Kiptoo", "technician"],
    ],
    menu: [
      ["Breakfast", [["Full English Breakfast", 750], ["Mandazi & Chai", 250]]],
      ["Main Course", [["Nyama Choma Platter", 1200], ["Grilled Tilapia", 1450], ["Chicken Biryani", 950]]],
      ["Beverages", [["Fresh Passion Juice", 300], ["Soda 500ml", 120], ["Dawa Cocktail", 650]]],
    ],
    inventory: [
      ["BEEF-001", "Beef Sirloin", "kg", 18, 30, 620],
      ["TILAPIA-001", "Tilapia (whole)", "kg", 6, 15, 480],
      ["RICE-001", "Basmati Rice", "kg", 12, 25, 190],
      ["FLOUR-001", "Wheat Flour", "kg", 22, 20, 95],
      ["PASSION-001", "Passion Fruit", "kg", 4, 10, 210],
      ["COKE-001", "Soda 500ml", "pcs", 96, 60, 35],
    ],
    guests: [
      "Alice Muthoni",
      "David Kimani",
      "Sarah Ochieng",
      "Joseph Mutiso",
      "Esther Wambui",
      "Michael Njoroge",
    ],
  });

  const lakeview = await seedHotel({
    passwordHash,
    name: "Lakeview Lodge",
    slug: "lakeview-lodge",
    email: "stay@lakeview-lodge.demo",
    phone: "+254 700 000 202",
    address: "Moi South Lake Road, Naivasha",
    planId: "STARTER",
    roomRates: { single: 5200, double: 7800, twin: 7400 },
    rooms: [
      ["A1", "Ground", "Single"],
      ["A2", "Ground", "Double"],
      ["A3", "Ground", "Double"],
      ["B1", "First", "Double"],
      ["B2", "First", "Twin"],
      ["B3", "First", "Double"],
    ],
    staff: [
      ["HOTEL_OWNER", "Daniel ole Saitoti", "owner"],
      ["HOTEL_ADMIN", "Wanjiru Kamau", "admin"],
      ["MANAGER", "Ahmed Hassan", "manager"],
      ["RECEPTIONIST", "Cynthia Nafula", "receptionist"],
      ["ACCOUNTANT", "Robert Wafula", "accountant"],
      ["WAITER", "Judy Nyambura", "waiter"],
      ["CASHIER", "Elvis Wekesa", "cashier"],
      ["HOUSEKEEPER", "Mary Wambui", "housekeeping"],
      ["TECHNICIAN", "Peter Omondi", "technician"],
    ],
    menu: [
      ["Breakfast", [["Lakeview Creamy Oatmeal", 450], ["Toast & Eggs", 550]]],
      ["Main Course", [["Grilled Trout", 1350], ["Vegetable Curry", 780]]],
      ["Beverages", [["Fresh Lemonade", 250], ["Coffee", 200]]],
    ],
    inventory: [
      ["TROUT-001", "Trout (whole)", "kg", 9, 20, 690],
      ["OATS-001", "Rolled Oats", "kg", 14, 10, 160],
      ["LEMON-001", "Lemons", "kg", 5, 8, 180],
      ["COFFEE-001", "Coffee Beans", "kg", 7, 5, 1200],
    ],
    guests: ["Purity Kerubo", "George Barasa", "Anne Njoki", "Stephen Kilonzo"],
  });

  mkdirSync(join(ROOT, ".owner-test"), { recursive: true });
  const target = join(ROOT, ".owner-test", "credentials.json");
  const payload = {
    generatedAt: new Date().toISOString(),
    database: process.env.DATABASE_URL?.replace(/:\/\/[^@]*@/, "://***@"),
    note: "Local demo data. These accounts exist only in the owner-test database.",
    password: PASSWORD,
    accounts: CREDENTIALS,
    hotels: [
      { name: "Riverside Grand Hotel", slug: riverside.slug, id: riverside.id },
      { name: "Lakeview Lodge", slug: lakeview.slug, id: lakeview.id },
    ],
    fingerprint: createHash("sha256").update(PASSWORD).digest("hex").slice(0, 12),
  };
  writeFileSync(target, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(
    join(ROOT, ".owner-test", "CREDENTIALS.md"),
    renderCredentialsMarkdown(payload),
    { mode: 0o600 }
  );

  console.log(`Seeded 2 hotels and ${CREDENTIALS.length} accounts.`);
  console.log(`Credentials written to ${target} (git-ignored).`);
  console.log(`Password fingerprint: ${payload.fingerprint}`);
}

function renderCredentialsMarkdown(payload: {
  generatedAt: string;
  password: string;
  accounts: Array<{ hotel: string; role: string; name: string; email: string }>;
  hotels: Array<{ name: string; slug: string }>;
}): string {
  const rows = payload.accounts
    .map((a) => `| ${a.hotel} | ${a.role} | ${a.name} | \`${a.email}\` |`)
    .join("\n");
  return `# Owner acceptance-testing credentials

Generated ${payload.generatedAt}. **Local demo data only — never production.**

Password for every demo account: \`${payload.password}\`

| Hotel | Role | Name | Email |
|---|---|---|---|
${rows}

Hotels: ${payload.hotels.map((h) => h.name).join(", ")}.

This file lives in \`.owner-test/\`, which is git-ignored. Deleting that directory
and re-running \`node scripts/owner-test-env.mjs setup\` issues a new password.
`;
}

interface HotelSpec {
  passwordHash: string;
  name: string;
  slug: string;
  email: string;
  phone: string;
  address: string;
  planId: string;
  roomRates: { single: number; double: number; twin: number };
  rooms: Array<[string, string, "Single" | "Double" | "Twin"]>;
  staff: Array<[HotelRole, string, string]>;
  menu: Array<[string, Array<[string, number]>]>;
  inventory: Array<[string, string, string, number, number, number]>;
  guests: string[];
}

async function seedHotel(spec: HotelSpec) {
  const hotel = await prisma.hotel.create({
    data: {
      name: spec.name,
      slug: spec.slug,
      email: spec.email,
      phone: spec.phone,
      address: spec.address,
      currency: "KES",
      timezone: "Africa/Nairobi",
      status: "ACTIVE",
    },
  });
  const hotelId = hotel.id;

  // ---- subscription ------------------------------------------------------
  const trialStarted = daysFromToday(-45);
  await prisma.subscription.create({
    data: {
      hotelId,
      planId: spec.planId,
      status: "ACTIVE",
      trialStartsAt: trialStarted,
      trialEndsAt: daysFromToday(-31),
      currentPeriodStartsAt: daysFromToday(-15),
      currentPeriodEndsAt: daysFromToday(15),
      amount: spec.planId === "PROFESSIONAL" ? 9500 : 4500,
      currency: "KES",
      billingInterval: "MONTHLY",
    },
  });

  // ---- staff, one account per role --------------------------------------
  const usersByRole = new Map<HotelRole, { id: string; name: string; email: string }>();
  for (const [role, name, handle] of spec.staff) {
    const email = `${handle}@${spec.slug}.demo`;
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: spec.passwordHash,
        memberships: {
          create: { hotelId, role, status: "ACTIVE", department: departmentFor(role) },
        },
      },
    });
    usersByRole.set(role, { id: user.id, name, email });
    CREDENTIALS.push({ hotel: spec.name, role, name, email });
  }
  const owner = usersByRole.get("HOTEL_OWNER")!;
  const receptionist = usersByRole.get("RECEPTIONIST") ?? owner;
  const housekeeper = usersByRole.get("HOUSEKEEPER") ?? owner;
  const technician = usersByRole.get("TECHNICIAN") ?? owner;
  const accountant = usersByRole.get("ACCOUNTANT") ?? owner;
  const waiter = usersByRole.get("WAITER") ?? owner;

  // ---- payment methods ---------------------------------------------------
  const methods = new Map<string, string>();
  for (const name of ["Cash", "M-Pesa", "Card"]) {
    const method = await prisma.paymentMethod.create({ data: { hotelId, name } });
    methods.set(name, method.id);
  }

  // ---- room types (tariffs) and rooms -----------------------------------
  const types = new Map<string, { id: string; rate: number }>();
  for (const [occupancy, mealPlans] of [
    ["Single", ["BED_ONLY", "BED_AND_BREAKFAST"]],
    ["Double", ["BED_AND_BREAKFAST", "HALF_BOARD"]],
    ["Twin", ["BED_AND_BREAKFAST"]],
  ] as const) {
    for (const mealPlan of mealPlans) {
      const label = mealPlan === "BED_ONLY" ? "Bed Only" : mealPlan === "BED_AND_BREAKFAST" ? "Bed & Breakfast" : "Half Board";
      const rate =
        occupancy === "Single"
          ? spec.roomRates.single
          : occupancy === "Double"
          ? spec.roomRates.double
          : spec.roomRates.twin;
      const type = await prisma.roomType.create({
        data: {
          hotelId,
          name: `${occupancy} - ${label}`,
          description: `${occupancy} room, ${label.toLowerCase()}`,
          baseRate: rate + (mealPlan === "HALF_BOARD" ? 2000 : 0),
          capacity: occupancy === "Single" ? 1 : 2,
          mealPlan,
          amenities: ["Wi-Fi", "Hot water"],
        },
      });
      types.set(`${occupancy}|${mealPlan}`, { id: type.id, rate: Number(type.baseRate) });
    }
  }

  const rooms: Array<{ id: string; number: string; rate: number }> = [];
  for (const [number, floor, occupancy] of spec.rooms) {
    const type =
      types.get(`${occupancy}|${spec.planId === "STARTER" ? "BED_ONLY" : "BED_AND_BREAKFAST"}`) ??
      types.get(`${occupancy}|BED_AND_BREAKFAST`) ??
      types.get(`${occupancy}|BED_ONLY`)!;
    const room = await prisma.room.create({
      data: { hotelId, number, floor, roomTypeId: type.id, status: "AVAILABLE" },
    });
    rooms.push({ id: room.id, number, rate: type.rate });
  }

  // ---- guests ------------------------------------------------------------
  const guests: Array<{ id: string; fullName: string }> = [];
  for (const [index, fullName] of spec.guests.entries()) {
    guests.push(
      await prisma.guest.create({
        data: {
          hotelId,
          fullName,
          phone: `+2547${String(10_000_000 + index * 137_919).slice(0, 8)}`,
          email: `${fullName.split(" ")[0].toLowerCase()}@guest.demo`,
          nationality: "Kenyan",
        },
      })
    );
  }

  // ---- reservations: one in-house, one arriving today, one future, one
  // cancelled, one checked out with a settled folio ------------------------
  let sequence = 1;
  async function book(options: {
    guest: (typeof guests)[number];
    room: (typeof rooms)[number];
    inDate: Date;
    outDate: Date;
    status: "PENDING" | "CONFIRMED" | "CHECKED_IN" | "CHECKED_OUT" | "CANCELLED";
    paid?: number;
    method?: string;
  }) {
    const nights = Math.max(
      1,
      Math.round((options.outDate.getTime() - options.inDate.getTime()) / 86_400_000)
    );
    const total = options.room.rate * nights;
    const reservation = await prisma.reservation.create({
      data: {
        hotelId,
        code: code("RES", sequence++),
        guestId: options.guest.id,
        checkInDate: options.inDate,
        checkOutDate: options.outDate,
        status: options.status,
        source: "WALK_IN",
        adults: 1,
        createdById: receptionist.id,
        rooms: { create: { roomId: options.room.id, rate: options.room.rate } },
      },
    });

    if (options.status === "CANCELLED" || options.status === "PENDING") return reservation;

    const folio = await prisma.folio.create({
      data: {
        hotelId,
        guestId: options.guest.id,
        reservationId: reservation.id,
        isClosed: options.status === "CHECKED_OUT",
        items: {
          create: {
            type: "ROOM_CHARGE",
            description: `Room ${options.room.number} - ${nights} night(s) @ KES ${options.room.rate}`,
            quantity: 1,
            unitPrice: total,
            total,
          },
        },
      },
    });

    const paid = options.paid ?? 0;
    if (paid > 0) {
      await prisma.payment.create({
        data: {
          hotelId,
          folioId: folio.id,
          paymentMethodId: methods.get(options.method ?? "M-Pesa")!,
          amount: paid,
          reference: options.method === "M-Pesa" ? `QK${randomBytes(3).toString("hex").toUpperCase()}` : null,
          cashierId: receptionist.id,
        },
      });
    }
    return reservation;
  }

  // Two hotels with different amounts of data both need the same shape of stay,
  // so guests are cycled rather than indexed directly.
  const guestAt = (index: number) => guests[index % guests.length];

  await book({ guest: guestAt(0), room: rooms[0], inDate: daysFromToday(-1), outDate: daysFromToday(2), status: "CHECKED_IN", paid: 6500 });
  await book({ guest: guestAt(1), room: rooms[1], inDate: daysFromToday(0), outDate: daysFromToday(1), status: "CONFIRMED" });
  await book({ guest: guestAt(2), room: rooms[2], inDate: daysFromToday(2), outDate: daysFromToday(4), status: "CONFIRMED" });
  await book({ guest: guestAt(3), room: rooms[3], inDate: daysFromToday(-10), outDate: daysFromToday(-8), status: "CHECKED_OUT", paid: 0, method: "Cash" });
  await book({ guest: guestAt(4), room: rooms[4], inDate: daysFromToday(5), outDate: daysFromToday(6), status: "CANCELLED" });

  // The in-house guest has an outstanding balance and a restaurant charge, so
  // the front desk, folio and reporting screens all have something real.
  const inHouse = await prisma.reservation.findFirst({
    where: { hotelId, status: "CHECKED_IN" },
    include: { folios: true },
  });
  if (inHouse?.folios[0]) {
    await prisma.folioItem.create({
      data: {
        folioId: inHouse.folios[0].id,
        type: "RESTAURANT",
        description: "Dinner - Nyama Choma Platter x1, Dawa Cocktail x2",
        quantity: 1,
        unitPrice: 2500,
        total: 2500,
      },
    });
  }

  // Room status follows the stays so housekeeping and availability agree.
  await prisma.room.update({ where: { id_hotelId: { id: rooms[0].id, hotelId } }, data: { status: "OCCUPIED" } });

  // ---- menu, inventory, recipes -----------------------------------------
  const inventoryItems = new Map<string, { id: string; name: string; unit: string }>();
  for (const [sku, name, unit, stock, reorder, cost] of spec.inventory) {
    const item = await prisma.inventoryItem.create({
      data: {
        hotelId,
        sku,
        name,
        category: "Kitchen",
        unit,
        currentStock: stock,
        reorderLevel: reorder,
        costPerUnit: cost,
        supplier: "Nakuru Fresh Supplies",
      },
    });
    inventoryItems.set(sku, { id: item.id, name, unit });
    await prisma.stockMovement.create({
      data: {
        hotelId,
        inventoryItemId: item.id,
        type: "OPENING_BALANCE",
        quantity: stock,
        beforeQty: 0,
        afterQty: stock,
        reference: "Opening stock",
        userId: accountant.id,
      },
    });
  }

  const menuItems: Array<{ id: string; name: string }> = [];
  for (const [categoryName, items] of spec.menu) {
    const category = await prisma.menuCategory.create({ data: { hotelId, name: categoryName } });
    for (const [itemName, price] of items) {
      const item = await prisma.menuItem.create({
        data: { hotelId, categoryId: category.id, name: itemName, price },
      });
      menuItems.push({ id: item.id, name: itemName });
    }
  }

  // A recipe on the flagship dish so the POS deducts stock and the recipe
  // screens are not empty.
  const flagship = menuItems[0];
  const ingredient = inventoryItems.values().next().value;
  if (flagship && ingredient) {
    const recipe = await prisma.recipe.create({
      data: { hotelId, menuItemId: flagship.id, portions: 1 },
    });
    await prisma.recipeIngredient.create({
      data: { recipeId: recipe.id, hotelId, inventoryItemId: ingredient.id, quantity: 200 },
    });
  }

  // ---- housekeeping, maintenance, expenses ------------------------------
  await prisma.housekeepingTask.create({
    data: {
      hotelId,
      roomId: rooms[2].id,
      status: "NEEDS_CLEANING",
      assigneeId: housekeeper.id,
      priority: "normal",
    },
  });
  await prisma.housekeepingTask.create({
    data: { hotelId, roomId: rooms[5].id, status: "IN_PROGRESS", assigneeId: housekeeper.id, priority: "high" },
  });

  await prisma.maintenanceTicket.create({
    data: {
      hotelId,
      roomId: rooms[1].id,
      title: "Air conditioner not cooling",
      description: "Guest reported warm air from unit 102.",
      priority: "high",
      status: "OPEN",
      assigneeId: technician.id,
    },
  });

  await prisma.expense.create({
    data: {
      hotelId,
      category: "UTILITIES",
      description: "Monthly water bill",
      amount: 18_500,
      paymentMethod: "Bank Transfer",
      supplier: "Nakuru Water",
      status: "APPROVED",
      requestedById: accountant.id,
    },
  });

  // ---- notifications: the bell should already have something in it ------
  await prisma.notification.createMany({
    data: [
      {
        hotelId,
        type: "STOCK_ALERT",
        title: `Low stock: ${spec.inventory[0][1]}`,
        message: `${spec.inventory[0][1]} is at or below its reorder level. Order from the supplier.`,
      },
      {
        hotelId,
        type: "MAINTENANCE",
        title: "Maintenance: Air conditioner not cooling",
        message: "Room 102 - high priority ticket opened.",
      },
      {
        hotelId,
        type: "BILLING",
        title: `Subscription renews in 15 days`,
        message: `${spec.planId} plan renews on ${daysFromToday(15).toISOString().slice(0, 10)}.`,
      },
    ],
  });

  // ---- one POS sale so restaurant reporting has revenue ------------------
  const posGuest = guests[guests.length - 1];
  const posItem = menuItems[1] ?? menuItems[0];
  if (posItem) {
    const folio = await prisma.folio.create({
      data: { hotelId, guestId: posGuest.id, isClosed: true },
    });
    const lineTotal = 1_200;
    await prisma.folioItem.create({
      data: {
        folioId: folio.id,
        type: "RESTAURANT",
        description: `${posItem.name} x1`,
        quantity: 1,
        unitPrice: lineTotal,
        total: lineTotal,
      },
    });
    await prisma.payment.create({
      data: {
        hotelId,
        folioId: folio.id,
        paymentMethodId: methods.get("Cash")!,
        amount: lineTotal,
        cashierId: waiter.id,
      },
    });
    await prisma.order.create({
      data: {
        hotelId,
        status: "PAID",
        paymentMethodId: methods.get("Cash")!,
        folioId: folio.id,
        total: lineTotal,
        items: {
          create: {
            menuItemId: posItem.id,
            name: posItem.name,
            unitPrice: lineTotal,
            quantity: 1,
            total: lineTotal,
          },
        },
      },
    });
  }

  return { id: hotelId, slug: spec.slug };
}

function departmentFor(role: HotelRole): string {
  switch (role) {
    case "HOUSEKEEPER":
      return "Housekeeping";
    case "WAITER":
    case "CASHIER":
      return "Restaurant";
    case "TECHNICIAN":
      return "Maintenance";
    case "ACCOUNTANT":
      return "Finance";
    case "RECEPTIONIST":
      return "Front Desk";
    default:
      return "Administration";
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

export type { Prisma };
