import { prisma } from "@/lib/prisma";
import { getStockStatus } from "@/lib/inventory";
import InventoryClient from "@/components/inventory/InventoryClient";
import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const tenant = await requirePageRole(ROLE_GROUPS.MANAGEMENT);

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [items, todaysMovements, todaysPurchases] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { hotelId: tenant.hotelId },
      orderBy: { name: "asc" },
    }),
    prisma.stockMovement.findMany({
      where: {
        hotelId: tenant.hotelId,
        inventoryItem: { is: { hotelId: tenant.hotelId } },
        createdAt: { gte: startOfToday },
        type: { in: ["MEAL_SALE", "WASTAGE"] },
      },
      include: { inventoryItem: true },
    }),
    prisma.purchase.findMany({
      where: {
        hotelId: tenant.hotelId,
        inventoryItem: { is: { hotelId: tenant.hotelId } },
        purchaseDate: { gte: startOfToday },
      },
    }),
  ]);

  const initialItems = items.map((item) => {
    const currentStock = Number(item.currentStock);
    const reorderLevel = Number(item.reorderLevel);
    const costPerUnit = Number(item.costPerUnit);
    return {
      id: item.id,
      sku: item.sku,
      name: item.name,
      category: item.category,
      unit: item.unit,
      currentStock,
      reorderLevel,
      costPerUnit,
      supplier: item.supplier,
      stockValue: Math.round(currentStock * costPerUnit),
      status: getStockStatus(currentStock, reorderLevel),
    };
  });

  const todaysConsumption = Math.round(
    todaysMovements.reduce(
      (sum, movement) =>
        sum + Math.abs(Number(movement.quantity)) * Number(movement.inventoryItem.costPerUnit),
      0
    )
  );
  const todaysPurchasesValue = Math.round(
    todaysPurchases.reduce((sum, purchase) => sum + Number(purchase.totalCost), 0)
  );

  const kpis = {
    totalItems: initialItems.length,
    totalValue: initialItems.reduce((sum, item) => sum + item.stockValue, 0),
    lowStock: initialItems.filter((item) => item.status === "LOW_STOCK" || item.status === "CRITICAL").length,
    outOfStock: initialItems.filter((item) => item.status === "OUT_OF_STOCK").length,
    todaysConsumption,
    todaysPurchases: todaysPurchasesValue,
  };

  return <InventoryClient initialItems={initialItems} kpis={kpis} />;
}
