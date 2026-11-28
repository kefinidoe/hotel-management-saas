import { NextResponse } from "next/server";
import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { accommodationRequiredExact, folioTotalsExact, roundMoneyDecimal, stayNights } from "@/lib/billing";
import { getStockStatus } from "@/lib/inventory";
import {
  getReportRange,
  reportDateKey,
  ReportRangeError,
} from "@/lib/reporting";

const RESERVATION_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "CHECKED_IN",
  "CHECKED_OUT",
  "CANCELLED",
  "NO_SHOW",
] as const;

function restaurantItemName(description: string) {
  const separator = " — ";
  const separatorIndex = description.indexOf(separator);
  return separatorIndex >= 0 ? description.slice(separatorIndex + separator.length) : description;
}

export async function GET(req: Request) {
  const tenant = await getTenantFromRoute("read");
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.FINANCIAL_REPORTS);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "REPORTS", "read");
  if (blocked) return blocked;

  const { searchParams } = new URL(req.url);
  let range: ReturnType<typeof getReportRange>;
  try {
    range = getReportRange(searchParams.get("start"), searchParams.get("end"));
  } catch (error) {
    if (error instanceof ReportRangeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "The report date range is invalid." }, { status: 400 });
  }

  const period = { gte: range.start, lt: range.endExclusive };

  const [folioItems, payments, expenses, reservations, restaurantItems, inventoryItems, allTariffs] =
    await Promise.all([
      prisma.folioItem.groupBy({
        by: ["type"],
        where: { createdAt: period, folio: { hotelId: tenant.hotelId } },
        _sum: { total: true },
      }),
      prisma.payment.findMany({
        where: { hotelId: tenant.hotelId, createdAt: period, status: "COMPLETED" },
        select: {
          amount: true,
          paymentMethod: { select: { name: true } },
        },
      }),
      prisma.expense.findMany({
        where: { hotelId: tenant.hotelId, createdAt: period, status: "APPROVED" },
        select: { category: true, amount: true },
      }),
      prisma.reservation.findMany({
        // Hotel stays use a half-open interval: check-in is included and
        // check-out is the first instant after the final occupied night.
        where: {
          hotelId: tenant.hotelId,
          checkInDate: { lt: range.endExclusive },
          checkOutDate: { gt: range.start },
        },
        orderBy: [{ checkInDate: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          code: true,
          checkInDate: true,
          checkOutDate: true,
          status: true,
          source: true,
          adults: true,
          children: true,
          discount: true,
          createdAt: true,
          guest: {
            select: { id: true, fullName: true, phone: true, email: true },
          },
          rooms: {
            select: {
              rate: true,
              room: {
                select: {
                  number: true,
                  roomType: { select: { name: true } },
                },
              },
            },
          },
          folios: {
            select: {
              id: true,
              isClosed: true,
              items: { select: { type: true, total: true } },
              payments: {
                where: { status: "COMPLETED" },
                select: { amount: true },
              },
            },
          },
        },
      }),
      prisma.folioItem.findMany({
        where: {
          folio: { hotelId: tenant.hotelId },
          type: "RESTAURANT",
          createdAt: period,
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          description: true,
          quantity: true,
          unitPrice: true,
          total: true,
          createdAt: true,
          folio: {
            select: {
              isClosed: true,
              reservationId: true,
              guest: { select: { fullName: true } },
              reservation: {
                select: {
                  code: true,
                  rooms: { select: { room: { select: { number: true } } } },
                },
              },
            },
          },
        },
      }),
      prisma.inventoryItem.findMany({
        where: {
          hotelId: tenant.hotelId,
          OR: [
            { isActive: true },
            { stockMovements: { some: { createdAt: period } } },
          ],
        },
        orderBy: { name: "asc" },
        select: {
          id: true,
          sku: true,
          name: true,
          category: true,
          unit: true,
          currentStock: true,
          reorderLevel: true,
          costPerUnit: true,
          isActive: true,
          stockMovements: {
            where: {
              createdAt: period,
              type: { in: ["MEAL_SALE", "WASTAGE", "ADJUSTMENT"] },
            },
            select: { type: true, quantity: true },
          },
        },
      }),
      prisma.roomType.findMany({
        where: { hotelId: tenant.hotelId },
      }),
    ]);

  // Financial activity recorded inside the selected date range.
  const billed = folioItems.map((item) => ({
    type: item.type,
    total: roundMoneyDecimal(String(item._sum.total ?? 0)).toNumber(),
  }));
  const billedTotal = roundMoneyDecimal(
    folioItems.reduce((sum, item) => sum.plus(String(item._sum.total ?? 0)), new Decimal(0))
  ).toNumber();

  const collectedByMethod = new Map<string, Decimal>();
  let collectedTotalDecimal = new Decimal(0);
  for (const payment of payments) {
    const method = payment.paymentMethod.name;
    const amount = new Decimal(String(payment.amount));
    collectedByMethod.set(
      method,
      (collectedByMethod.get(method) ?? new Decimal(0)).plus(amount)
    );
    collectedTotalDecimal = collectedTotalDecimal.plus(amount);
  }
  const collected = [...collectedByMethod.entries()]
    .map(([method, total]) => ({ method, total: roundMoneyDecimal(total).toNumber() }))
    .sort((a, b) => b.total - a.total);
  const collectedTotal = roundMoneyDecimal(collectedTotalDecimal).toNumber();

  const expensesByCategory = new Map<string, Decimal>();
  let expensesTotalDecimal = new Decimal(0);
  for (const expense of expenses) {
    const amount = new Decimal(String(expense.amount));
    expensesByCategory.set(
      expense.category,
      (expensesByCategory.get(expense.category) ?? new Decimal(0)).plus(amount)
    );
    expensesTotalDecimal = expensesTotalDecimal.plus(amount);
  }
  const expensesBreakdown = [...expensesByCategory.entries()]
    .map(([category, total]) => ({ category, total: roundMoneyDecimal(total).toNumber() }))
    .sort((a, b) => b.total - a.total);
  const expensesTotal = roundMoneyDecimal(expensesTotalDecimal).toNumber();

  // Booking history is selected by stay overlap, but each row shows the
  // complete financial history of that booking, not just charges posted in
  // the selected date range.
  const bookingHistory = reservations.map((reservation) => {
    const chargeTotals = new Map<string, Decimal>();
    let amountPaid = new Decimal(0);

    for (const folio of reservation.folios) {
      for (const item of folio.items) {
        chargeTotals.set(
          item.type,
          (chargeTotals.get(item.type) ?? new Decimal(0)).plus(String(item.total))
        );
      }
      for (const payment of folio.payments) {
        amountPaid = amountPaid.plus(String(payment.amount));
      }
    }

    const roomCharges = chargeTotals.get("ROOM_CHARGE") ?? new Decimal(0);
    const discounts = chargeTotals.get("DISCOUNT") ?? new Decimal(0);
    const accommodationSpent = roomCharges.plus(discounts);
    const restaurantSpent = chargeTotals.get("RESTAURANT") ?? new Decimal(0);
    const otherSpent = (chargeTotals.get("LAUNDRY") ?? new Decimal(0))
      .plus(chargeTotals.get("OTHER_SERVICE") ?? new Decimal(0))
      .plus(chargeTotals.get("TAX") ?? new Decimal(0));
    const totalBilled = [...chargeTotals.values()].reduce(
      (sum, total) => sum.plus(total),
      new Decimal(0)
    );

    let rawAccommodation = new Decimal(0);
    try {
      rawAccommodation = accommodationRequiredExact(
        reservation.rooms.map((room) => String(room.rate)),
        stayNights(reservation.checkInDate, reservation.checkOutDate),
        String(reservation.discount ?? 0)
      );
    } catch {
      // Preserve the history row even if old data is incomplete.
      rawAccommodation = new Decimal(0);
    }

    const isCancelled = reservation.status === "CANCELLED";
    const bookedAccommodation = isCancelled ? new Decimal(0) : rawAccommodation;
    const cancelledAccommodation = isCancelled ? rawAccommodation : new Decimal(0);

    return {
      id: reservation.id,
      code: reservation.code,
      guest: reservation.guest,
      checkInDate: reservation.checkInDate.toISOString(),
      checkOutDate: reservation.checkOutDate.toISOString(),
      createdAt: reservation.createdAt.toISOString(),
      status: reservation.status,
      source: reservation.source,
      adults: reservation.adults,
      children: reservation.children,
      rooms: reservation.rooms.map((room) => {
        const matched = allTariffs.find((t) =>
          new Decimal(String(t.baseRate)).eq(String(room.rate))
        );
        return {
          number: room.room.number,
          roomType: matched ? matched.name : room.room.roomType.name,
          nightlyRate: Number(room.rate),
        };
      }),
      bookedAccommodation: roundMoneyDecimal(bookedAccommodation).toNumber(),
      cancelledAccommodation: roundMoneyDecimal(cancelledAccommodation).toNumber(),
      accommodationSpent: roundMoneyDecimal(accommodationSpent).toNumber(),
      restaurantSpent: roundMoneyDecimal(restaurantSpent).toNumber(),
      otherSpent: roundMoneyDecimal(otherSpent).toNumber(),
      totalBilled: roundMoneyDecimal(totalBilled).toNumber(),
      amountPaid: roundMoneyDecimal(amountPaid).toNumber(),
      balance: roundMoneyDecimal(
        folioTotalsExact(
          reservation.folios.flatMap((f) => f.items.map((i) => String(i.total))),
          reservation.folios.flatMap((f) => f.payments.map((p) => String(p.amount)))
        ).balance
      ).toNumber(),
      folioCount: reservation.folios.length,
      foliosClosed:
        reservation.folios.length > 0 &&
        reservation.folios.every((folio) => folio.isClosed),
    };
  });

  const bookingStatusCounts = Object.fromEntries(
    RESERVATION_STATUSES.map((status) => [
      status,
      bookingHistory.filter((booking) => booking.status === status).length,
    ])
  );
  const bookingSummary = {
    totalBookings: bookingHistory.length,
    statusCounts: bookingStatusCounts,
    bookedAccommodation: roundMoneyDecimal(
      bookingHistory.reduce(
        (sum, booking) => sum.plus(String(booking.bookedAccommodation)),
        new Decimal(0)
      )
    ).toNumber(),
    cancelledAccommodation: roundMoneyDecimal(
      bookingHistory.reduce(
        (sum, booking) => sum.plus(String(booking.cancelledAccommodation)),
        new Decimal(0)
      )
    ).toNumber(),
    totalBilled: roundMoneyDecimal(
      bookingHistory.reduce((sum, booking) => sum.plus(String(booking.totalBilled)), new Decimal(0))
    ).toNumber(),
    amountPaid: roundMoneyDecimal(
      bookingHistory.reduce((sum, booking) => sum.plus(String(booking.amountPaid)), new Decimal(0))
    ).toNumber(),
    balanceDue: roundMoneyDecimal(
      bookingHistory.reduce(
        (sum, booking) => sum.plus(Decimal.max(0, String(booking.balance))),
        new Decimal(0)
      )
    ).toNumber(),
    creditBalance: roundMoneyDecimal(
      bookingHistory.reduce(
        (sum, booking) => sum.plus(Decimal.max(0, new Decimal(String(booking.balance)).negated())),
        new Decimal(0)
      )
    ).toNumber(),
  };

  // A restaurant folio item is created only after a POS transaction succeeds.
  // This is the reliable sales record used by the current application for both
  // pay-now and charge-to-room sales.
  const restaurantSales = restaurantItems.map((item) => ({
    id: item.id,
    itemName: restaurantItemName(item.description),
    description: item.description,
    quantity: item.quantity,
    unitPrice: Number(item.unitPrice),
    total: Number(item.total),
    createdAt: item.createdAt.toISOString(),
    channel: item.folio.reservationId ? "ROOM_CHARGE" : "PAY_NOW",
    guestName: item.folio.guest.fullName,
    reservationCode: item.folio.reservation?.code ?? null,
    roomNumbers:
      item.folio.reservation?.rooms.map((room) => room.room.number) ?? [],
    folioClosed: item.folio.isClosed,
  }));

  const restaurantByDay = new Map<string, Decimal>();
  const restaurantByItem = new Map<
    string,
    { itemName: string; quantity: number; revenue: Decimal }
  >();
  let payNowRevenue = new Decimal(0);
  let roomChargeRevenue = new Decimal(0);
  let restaurantRevenueDecimal = new Decimal(0);

  for (const item of restaurantItems) {
    const itemName = restaurantItemName(item.description);
    const channel = item.folio.reservationId ? "ROOM_CHARGE" : "PAY_NOW";
    const lineTotal = new Decimal(String(item.total));
    const day = reportDateKey(item.createdAt);
    restaurantByDay.set(day, (restaurantByDay.get(day) ?? new Decimal(0)).plus(lineTotal));

    const current = restaurantByItem.get(itemName) ?? {
      itemName,
      quantity: 0,
      revenue: new Decimal(0),
    };
    current.quantity += item.quantity;
    current.revenue = current.revenue.plus(lineTotal);
    restaurantByItem.set(itemName, current);

    restaurantRevenueDecimal = restaurantRevenueDecimal.plus(lineTotal);
    if (channel === "PAY_NOW") payNowRevenue = payNowRevenue.plus(lineTotal);
    else roomChargeRevenue = roomChargeRevenue.plus(lineTotal);
  }

  const restaurant = {
    summary: {
      revenue: roundMoneyDecimal(restaurantRevenueDecimal).toNumber(),
      itemsSold: restaurantSales.reduce((sum, sale) => sum + sale.quantity, 0),
      saleLines: restaurantSales.length,
      payNowRevenue: roundMoneyDecimal(payNowRevenue).toNumber(),
      roomChargeRevenue: roundMoneyDecimal(roomChargeRevenue).toNumber(),
    },
    revenueByDay: [...restaurantByDay.entries()]
      .map(([date, revenue]) => ({ date, revenue: roundMoneyDecimal(revenue).toNumber() }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    topItems: [...restaurantByItem.values()]
      .map((item) => ({ ...item, revenue: roundMoneyDecimal(item.revenue).toNumber() }))
      .sort((a, b) => b.revenue - a.revenue),
    sales: restaurantSales,
  };

  const stock = inventoryItems.map((item) => {
    let usedInSales = new Decimal(0);
    let wastage = new Decimal(0);
    let adjustmentAdded = new Decimal(0);
    let adjustmentRemoved = new Decimal(0);

    for (const movement of item.stockMovements) {
      const quantity = new Decimal(String(movement.quantity));
      if (movement.type === "MEAL_SALE" && quantity.lt(0)) {
        usedInSales = usedInSales.plus(quantity.abs());
      } else if (movement.type === "WASTAGE" && quantity.lt(0)) {
        wastage = wastage.plus(quantity.abs());
      } else if (movement.type === "ADJUSTMENT" && quantity.gte(0)) {
        adjustmentAdded = adjustmentAdded.plus(quantity);
      } else if (movement.type === "ADJUSTMENT") {
        adjustmentRemoved = adjustmentRemoved.plus(quantity.abs());
      }
    }

    const currentStockDecimal = new Decimal(String(item.currentStock));
    const costPerUnitDecimal = new Decimal(String(item.costPerUnit));
    const currentStock = currentStockDecimal.toNumber();
    const reorderLevel = Number(item.reorderLevel);
    const costPerUnit = costPerUnitDecimal.toNumber();

    return {
      id: item.id,
      sku: item.sku,
      name: item.name,
      category: item.category,
      unit: item.unit,
      isActive: item.isActive,
      currentStock,
      reorderLevel,
      status: getStockStatus(String(item.currentStock), String(item.reorderLevel)),
      usedInSales: roundMoneyDecimal(usedInSales).toNumber(),
      wastage: roundMoneyDecimal(wastage).toNumber(),
      adjustmentAdded: roundMoneyDecimal(adjustmentAdded).toNumber(),
      adjustmentRemoved: roundMoneyDecimal(adjustmentRemoved).toNumber(),
      costPerUnit,
      currentValue: roundMoneyDecimal(currentStockDecimal.mul(costPerUnitDecimal)).toNumber(),
      usageCost: roundMoneyDecimal(usedInSales.mul(costPerUnitDecimal)).toNumber(),
      wastageCost: roundMoneyDecimal(wastage.mul(costPerUnitDecimal)).toNumber(),
    };
  });

  const inventory = {
    summary: {
      activeItems: stock.filter((item) => item.isActive).length,
      lowStockItems: stock.filter(
        (item) => item.isActive && item.status !== "IN_STOCK"
      ).length,
      outOfStockItems: stock.filter(
        (item) => item.isActive && item.status === "OUT_OF_STOCK"
      ).length,
      currentStockValue: roundMoneyDecimal(
        stock
          .filter((item) => item.isActive)
          .reduce((sum, item) => sum.plus(String(item.currentValue)), new Decimal(0))
      ).toNumber(),
      usageCost: roundMoneyDecimal(
        stock.reduce((sum, item) => sum.plus(String(item.usageCost)), new Decimal(0))
      ).toNumber(),
      wastageCost: roundMoneyDecimal(
        stock.reduce((sum, item) => sum.plus(String(item.wastageCost)), new Decimal(0))
      ).toNumber(),
    },
    items: stock,
  };

  return NextResponse.json({
    range: {
      start: range.start.toISOString(),
      end: range.endInclusive.toISOString(),
      startDate: range.startDate,
      endDate: range.endDate,
      timeZone: range.timeZone,
      bookingBasis: "STAY_OVERLAP",
    },
    billed,
    billedTotal,
    collected,
    collectedTotal,
    expensesBreakdown,
    expensesTotal,
    netCashFlow: roundMoneyDecimal(collectedTotalDecimal.minus(expensesTotalDecimal)).toNumber(),
    bookingSummary,
    bookingHistory,
    restaurant,
    inventory,
  });
}
