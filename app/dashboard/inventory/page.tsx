import Decimal from "decimal.js";
import { roundMoneyDecimal } from "@/lib/billing";
import { DurableMutationProvider } from "@/components/recovery/DurableMutationProvider";
import { prisma } from "@/lib/prisma";
import { getStockStatus } from "@/lib/inventory";
import InventoryClient from "@/components/inventory/InventoryClient";
import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const tenant = await requirePageRole(ROLE_GROUPS.MANAGEMENT, "INVENTORY");

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
      stockVersion: item.stockVersion,
      reorderLevel,
      costPerUnit,
      supplier: item.supplier,
      stockValue: roundMoneyDecimal(
        new Decimal(String(item.currentStock)).mul(String(item.costPerUnit))
      ).toNumber(),
      status: getStockStatus(String(item.currentStock), String(item.reorderLevel)),
    };
  });

  const todaysConsumption = roundMoneyDecimal(
    todaysMovements.reduce(
      (sum, movement) =>
        sum.plus(
          new Decimal(String(movement.quantity))
            .abs()
            .mul(String(movement.inventoryItem.costPerUnit))
        ),
      new Decimal(0)
    )
  ).toNumber();
  const todaysPurchasesValue = roundMoneyDecimal(
    todaysPurchases.reduce(
      (sum, purchase) => sum.plus(String(purchase.totalCost)),
      new Decimal(0)
    )
  ).toNumber();

  const kpis = {
    totalItems: initialItems.length,
    totalValue: roundMoneyDecimal(
      items.reduce(
        (sum, item) => sum.plus(roundMoneyDecimal(new Decimal(String(item.currentStock)).mul(String(item.costPerUnit)))),
        new Decimal(0)
      )
    ).toNumber(),
    lowStock: initialItems.filter((item) => item.status === "LOW_STOCK" || item.status === "CRITICAL").length,
    outOfStock: initialItems.filter((item) => item.status === "OUT_OF_STOCK").length,
    todaysConsumption,
    todaysPurchases: todaysPurchasesValue,
  };

  return <DurableMutationProvider hotelId={tenant.hotelId} actorId={tenant.userId}><InventoryClient initialItems={initialItems} kpis={kpis} /></DurableMutationProvider>;
}
