import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantContext, TenantAuthError } from "@/lib/tenant-context";
import { HotelRole } from "@prisma/client";

export async function POST() {
  let tenant;
  try {
    tenant = await getTenantContext();
  } catch (error) {
    if (error instanceof TenantAuthError) {
      const response = NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.statusCode }
      );
      if (error.clearCookie) {
        response.cookies.delete("active_hotel_id");
      }
      return response;
    }
    return NextResponse.json({ error: "UNAUTHORIZED", message: "Authentication required" }, { status: 401 });
  }

  // Security Requirement 4: Disable destructive cleanup endpoint in SaaS environments by default
  if (
    process.env.NODE_ENV === "production" ||
    process.env.ALLOW_TEST_DATA_CLEANUP !== "true"
  ) {
    return NextResponse.json(
      {
        error: "FORBIDDEN",
        message:
          "Test data cleanup is strictly disabled in SaaS environments. Contact platform operations.",
      },
      { status: 403 }
    );
  }

  // Strictly enforce hotel administrative roles within the active tenant
  if (tenant.role !== HotelRole.HOTEL_OWNER && tenant.role !== HotelRole.HOTEL_ADMIN) {
    return NextResponse.json(
      { error: "FORBIDDEN", message: "Insufficient hotel management permissions" },
      { status: 403 }
    );
  }

  const hotelId = tenant.hotelId;

  // Destructive operations strictly scoped to active tenant (never delete across all hotels)
  const deletedPayments = await prisma.payment.deleteMany({ where: { hotelId } });
  const deletedFolioItems = await prisma.folioItem.deleteMany({ where: { folio: { hotelId } } });
  const deletedOrderItems = await prisma.orderItem.deleteMany({ where: { order: { hotelId } } });
  const deletedOrders = await prisma.order.deleteMany({ where: { hotelId } });
  const deletedFolios = await prisma.folio.deleteMany({ where: { hotelId } });
  const deletedReservationRooms = await prisma.reservationRoom.deleteMany({
    where: { reservation: { hotelId } },
  });
  const deletedReservations = await prisma.reservation.deleteMany({ where: { hotelId } });
  const deletedHousekeeping = await prisma.housekeepingTask.deleteMany({ where: { hotelId } });
  const deletedMaintenance = await prisma.maintenanceTicket.deleteMany({ where: { hotelId } });
  const deletedStockMovements = await prisma.stockMovement.deleteMany({ where: { hotelId } });
  const deletedPurchases = await prisma.purchase.deleteMany({ where: { hotelId } });
  const deletedWastage = await prisma.wastage.deleteMany({ where: { hotelId } });
  const deletedExpenses = await prisma.expense.deleteMany({ where: { hotelId } });
  const deletedNotifications = await prisma.notification.deleteMany({ where: { hotelId } });
  const deletedAuditLogs = await prisma.auditLog.deleteMany({ where: { hotelId } });
  const deletedGuests = await prisma.guest.deleteMany({ where: { hotelId } });
  const updatedRooms = await prisma.room.updateMany({
    where: { hotelId },
    data: {
      status: "AVAILABLE",
      notes: null,
    },
  });

  return NextResponse.json({
    ok: true,
    hotelId,
    summary: {
      payments: deletedPayments.count,
      folioItems: deletedFolioItems.count,
      orderItems: deletedOrderItems.count,
      orders: deletedOrders.count,
      folios: deletedFolios.count,
      reservationRooms: deletedReservationRooms.count,
      reservations: deletedReservations.count,
      housekeepingTasks: deletedHousekeeping.count,
      maintenanceTickets: deletedMaintenance.count,
      stockMovements: deletedStockMovements.count,
      purchases: deletedPurchases.count,
      wastage: deletedWastage.count,
      expenses: deletedExpenses.count,
      notifications: deletedNotifications.count,
      auditLogs: deletedAuditLogs.count,
      guests: deletedGuests.count,
      roomsReset: updatedRooms.count,
    },
  });
}
