import { PrismaClient } from "@prisma/client";
import { assertDatabaseSafety } from "../lib/db-safety-guard";

// Validate the configured target before constructing a client or issuing queries.
// This guard only checks the configured identifier; the explicit, matching hotel
// ID confirmation below is an additional safeguard, not proof that a DB is safe.
assertDatabaseSafety();

const prisma = new PrismaClient();

function readConfirmedHotelId(): string {
  const args = process.argv.slice(2);
  const valueAfter = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1]?.trim() : undefined;
  };
  const hotelId = valueAfter("--hotel-id");
  const confirmation = valueAfter("--confirm-hotel-id");

  if (!hotelId || !confirmation || hotelId !== confirmation) {
    throw new Error(
      "Refusing cleanup. Pass both --hotel-id <id> and --confirm-hotel-id <same-id> to scope and confirm the target hotel."
    );
  }
  return hotelId;
}

async function main() {
  const hotelId = readConfirmedHotelId();
  console.log("Starting hotel test-data cleanup for the explicitly confirmed hotel.\n");

  await prisma.$transaction(async (tx) => {
    const hotel = await tx.hotel.findUnique({
      where: { id: hotelId },
      select: { id: true, name: true, slug: true },
    });
    if (!hotel) throw new Error("The confirmed hotel ID does not exist in the configured database.");

    console.log(`Target hotel: ${hotel.name} (${hotel.slug})`);
    console.log("All deletion and room-reset operations below are scoped to this hotel.\n");

    const deletedPayments = await tx.payment.deleteMany({ where: { hotelId } });
    const deletedFolioItems = await tx.folioItem.deleteMany({ where: { folio: { hotelId } } });
    const deletedOrderItems = await tx.orderItem.deleteMany({ where: { order: { hotelId } } });
    const deletedOrders = await tx.order.deleteMany({ where: { hotelId } });
    const deletedFolios = await tx.folio.deleteMany({ where: { hotelId } });
    const deletedReservationRooms = await tx.reservationRoom.deleteMany({
      where: { reservation: { hotelId } },
    });
    const deletedReservations = await tx.reservation.deleteMany({ where: { hotelId } });
    const deletedHousekeeping = await tx.housekeepingTask.deleteMany({ where: { hotelId } });
    const deletedMaintenance = await tx.maintenanceTicket.deleteMany({ where: { hotelId } });
    const deletedRecipeIngredients = await tx.recipeIngredient.deleteMany({
      where: { recipe: { menuItem: { hotelId } } },
    });
    const deletedRecipes = await tx.recipe.deleteMany({ where: { menuItem: { hotelId } } });
    const deletedPurchases = await tx.purchase.deleteMany({ where: { hotelId } });
    const deletedWastage = await tx.wastage.deleteMany({ where: { hotelId } });
    const deletedStockMovements = await tx.stockMovement.deleteMany({ where: { hotelId } });
    const deletedExpenses = await tx.expense.deleteMany({ where: { hotelId } });
    const deletedNotifications = await tx.notification.deleteMany({ where: { hotelId } });
    const deletedAuditLogs = await tx.auditLog.deleteMany({ where: { hotelId } });
    const deletedGuests = await tx.guest.deleteMany({ where: { hotelId } });
    const updatedRooms = await tx.room.updateMany({
      where: { hotelId },
      data: { status: "AVAILABLE", notes: null },
    });

    console.log(`Deleted ${deletedPayments.count} payments`);
    console.log(`Deleted ${deletedFolioItems.count} folio items`);
    console.log(`Deleted ${deletedOrderItems.count} restaurant order items`);
    console.log(`Deleted ${deletedOrders.count} restaurant orders`);
    console.log(`Deleted ${deletedFolios.count} guest folios`);
    console.log(`Deleted ${deletedReservationRooms.count} reservation-room links`);
    console.log(`Deleted ${deletedReservations.count} reservations`);
    console.log(`Deleted ${deletedHousekeeping.count} housekeeping tasks`);
    console.log(`Deleted ${deletedMaintenance.count} maintenance tickets`);
    console.log(`Deleted ${deletedRecipes.count} recipes and ${deletedRecipeIngredients.count} recipe ingredients`);
    console.log(`Deleted ${deletedPurchases.count} purchases`);
    console.log(`Deleted ${deletedWastage.count} wastage records`);
    console.log(`Deleted ${deletedStockMovements.count} stock movements`);
    console.log(`Deleted ${deletedExpenses.count} expenses`);
    console.log(`Deleted ${deletedNotifications.count} notifications`);
    console.log(`Deleted ${deletedAuditLogs.count} audit logs`);
    console.log(`Deleted ${deletedGuests.count} guest profiles`);
    console.log(`Reset ${updatedRooms.count} rooms to AVAILABLE`);
  });

  console.log("\nCleanup transaction committed for the confirmed hotel only.");
  console.log("Staff, rooms, tariff configurations, menu items, and inventory items were preserved.");
}

main()
  .catch((error: unknown) => {
    // Avoid printing Prisma internals or connection details that may contain secrets.
    const message = error instanceof Error ? error.message : "Unknown cleanup error";
    console.error("Cleanup aborted. No success was reported.", message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
