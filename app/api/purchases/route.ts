import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { inventoryRequest } from "@/lib/inventory-idempotency";
import { syncLowStockAlerts } from "@/lib/notifications";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";

export async function GET() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "INVENTORY");
  if (blocked) return blocked;

  const purchases = await prisma.purchase.findMany({
    where: { hotelId: tenant.hotelId },
    include: { inventoryItem: true, createdBy: true },
    orderBy: { purchaseDate: "desc" },
    take: 100,
  });

  return NextResponse.json(
    purchases.map((p) => ({
      id: p.id,
      itemName: p.inventoryItem.name,
      unit: p.inventoryItem.unit,
      supplier: p.supplier,
      invoiceNumber: p.invoiceNumber,
      quantity: Number(p.quantity),
      unitCost: Number(p.unitCost),
      totalCost: Number(p.totalCost),
      purchaseDate: p.purchaseDate,
      createdByName: p.createdBy.name,
    }))
  );
}

// Recording a purchase increases stock and logs a StockMovement, atomically.
export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "INVENTORY");
  if (blocked) return blocked;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const { inventoryItemId, supplier, invoiceNumber, quantity, unitCost, purchaseDate } = body;
  const amount = Number(quantity);
  const cost = Number(unitCost);
  const date = purchaseDate ? new Date(purchaseDate) : new Date();
  if (typeof inventoryItemId !== "string" || !inventoryItemId.trim() || typeof supplier !== "string" || !supplier.trim() ||
      !Number.isFinite(amount) || amount <= 0 || !new Prisma.Decimal(amount).mul(100).isInteger() ||
      unitCost === undefined || unitCost === null || !Number.isFinite(cost) || cost < 0 || !new Prisma.Decimal(cost).mul(10000).isInteger() ||
      !Number.isFinite(date.getTime()) || (invoiceNumber != null && typeof invoiceNumber !== "string")) {
    return NextResponse.json({ error: "Provide a valid item, supplier, quantity (two decimals), cost (four decimals), and date." }, { status: 400 });
  }
  const qty = new Prisma.Decimal(amount);
  const price = new Prisma.Decimal(cost);
  const response = await inventoryRequest(req, tenant.hotelId, tenant.userId, "PURCHASE", body, async (tx) => {
    const changed = await tx.inventoryItem.updateMany({
      where: { id: inventoryItemId.trim(), hotelId: tenant.hotelId, currentStock: { gte: 0 } },
      data: { currentStock: { increment: qty }, stockVersion: { increment: 1 }, costPerUnit: price },
    });
    if (changed.count !== 1) {
      const existing = await tx.inventoryItem.findUnique({ where: { id_hotelId: { id: inventoryItemId.trim(), hotelId: tenant.hotelId } } });
      return existing
        ? { status: 409, body: { error: "Existing stock is negative. Reconcile it with a stocktake first." } }
        : { status: 404, body: { error: "Inventory item not found." } };
    }
    const item = await tx.inventoryItem.findUniqueOrThrow({
      where: { id_hotelId: { id: inventoryItemId.trim(), hotelId: tenant.hotelId } },
    });
    const after = item.currentStock;
    const purchase = await tx.purchase.create({
      data: {
        hotelId: tenant.hotelId, inventoryItemId: item.id, supplier: supplier.trim(),
        invoiceNumber: invoiceNumber?.trim() || null, quantity: qty, unitCost: price,
        totalCost: qty.mul(price).toDecimalPlaces(2), purchaseDate: date, createdById: tenant.userId,
      },
    });
    await tx.stockMovement.create({
      data: {
        hotelId: tenant.hotelId, inventoryItemId: item.id, type: "PURCHASE", quantity: qty,
        beforeQty: after.sub(qty), afterQty: after,
        reference: invoiceNumber ? `Invoice ${invoiceNumber.trim()}` : `Purchase from ${supplier.trim()}`,
        userId: tenant.userId,
      },
    });
    return { status: 201, body: purchase };
  });

  if (response.ok) await syncLowStockAlerts(tenant.hotelId);

  return response;
}