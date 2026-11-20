import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { inventoryRequest } from "@/lib/inventory-idempotency";
import { syncLowStockAlerts } from "@/lib/notifications";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tenant = await getTenantFromRoute("read");
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "INVENTORY", "read");
  if (blocked) return blocked;

  const item = await prisma.inventoryItem.findUnique({
    where: { id_hotelId: { id, hotelId: tenant.hotelId } },
    include: {
      stockMovements: {
        where: { hotelId: tenant.hotelId },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { user: true },
      },
      recipeIngredients: {
        include: { recipe: { include: { menuItem: true } } },
      },
    },
  });

  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }

  return NextResponse.json({
    id: item.id,
    sku: item.sku,
    name: item.name,
    category: item.category,
    unit: item.unit,
    currentStock: Number(item.currentStock),
    reorderLevel: Number(item.reorderLevel),
    costPerUnit: Number(item.costPerUnit),
    supplier: item.supplier,
    isActive: item.isActive,
    stockMovements: item.stockMovements.map((m) => ({
      id: m.id,
      type: m.type,
      quantity: Number(m.quantity),
      beforeQty: Number(m.beforeQty),
      afterQty: Number(m.afterQty),
      reference: m.reference,
      userName: m.user?.name ?? null,
      createdAt: m.createdAt,
    })),
    usedIn: item.recipeIngredients
      .filter((ri) => ri.recipe?.menuItem?.hotelId === tenant.hotelId)
      .map((ri) => ({
        menuItemName: ri.recipe.menuItem.name,
        quantity: Number(ri.quantity),
        portions: ri.recipe.portions,
      })),
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "INVENTORY");
  if (blocked) return blocked;

  const body = await req.json();

  const item = await prisma.inventoryItem.findUnique({
    where: { id_hotelId: { id, hotelId: tenant.hotelId } },
  });

  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }

  if (body.newQuantity !== undefined) {
    const afterNumber = Number(body.newQuantity);
    const expectedNumber = Number(body.expectedQuantity);
    const expectedVersion = body.expectedVersion;
    if (body.newQuantity === null || body.expectedQuantity === undefined || body.expectedQuantity === null ||
        !Number.isFinite(afterNumber) || afterNumber < 0 || !new Prisma.Decimal(afterNumber).mul(100).isInteger() ||
        !Number.isInteger(expectedVersion) || expectedVersion < 0 ||
        !Number.isFinite(expectedNumber) || !new Prisma.Decimal(expectedNumber).mul(100).isInteger() ||
        (body.reason !== undefined && typeof body.reason !== "string")) {
      return NextResponse.json({ error: "Valid non-negative quantities with at most two decimals and the expected stock balance are required." }, { status: 400 });
    }
    const after = new Prisma.Decimal(afterNumber);
    const before = new Prisma.Decimal(expectedNumber);
    // A stocktake is an absolute count, not a delta. Compare against the
    // balance displayed to the user so concurrent activity cannot be erased.
    const response = await inventoryRequest(req, tenant.hotelId, tenant.userId, "ADJUSTMENT", { id, body }, async (tx) => {
      const updated = await tx.inventoryItem.updateMany({
        where: { id: item.id, hotelId: tenant.hotelId, currentStock: before, stockVersion: expectedVersion },
        data: { currentStock: after, stockVersion: { increment: 1 } },
      });
      if (updated.count !== 1) return { status: 409, body: { error: "Stock changed since it was displayed. Refresh and retry the stocktake." } };
      const movement = await tx.stockMovement.create({ data: {
        hotelId: tenant.hotelId, inventoryItemId: item.id, type: "ADJUSTMENT",
        quantity: after.sub(before), beforeQty: before, afterQty: after,
        reference: body.reason?.trim() || "Manual adjustment", userId: tenant.userId,
      } });
      return { status: 200, body: { ok: true, movement } };
    });

    if (response.ok) await syncLowStockAlerts(tenant.hotelId);
    return response;
  }

  const updated = await prisma.inventoryItem.update({
    where: {
      id_hotelId: { id: item.id, hotelId: tenant.hotelId },
    },
    data: {
      name: body.name ?? undefined,
      category: body.category ?? undefined,
      reorderLevel: body.reorderLevel ?? undefined,
      costPerUnit: body.costPerUnit ?? undefined,
      supplier: body.supplier ?? undefined,
      isActive: body.isActive ?? undefined,
    },
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "INVENTORY");
  if (blocked) return blocked;

  const item = await prisma.inventoryItem.findUnique({
    where: { id_hotelId: { id, hotelId: tenant.hotelId } },
  });

  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }

  const [purchaseCount, wastageCount, movementCount, recipeCount] =
    await Promise.all([
      prisma.purchase.count({
        where: { hotelId: tenant.hotelId, inventoryItemId: id },
      }),
      prisma.wastage.count({
        where: { hotelId: tenant.hotelId, inventoryItemId: id },
      }),
      prisma.stockMovement.count({
        where: { hotelId: tenant.hotelId, inventoryItemId: id },
      }),
      prisma.recipeIngredient.count({
        where: { inventoryItemId: id },
      }),
    ]);

  const hasHistory =
    purchaseCount > 0 ||
    wastageCount > 0 ||
    movementCount > 0 ||
    recipeCount > 0;

  if (!hasHistory) {
    await prisma.inventoryItem.delete({
      where: { id_hotelId: { id, hotelId: tenant.hotelId } },
    });
    return NextResponse.json({ mode: "deleted" });
  }

  await prisma.inventoryItem.update({
    where: { id_hotelId: { id, hotelId: tenant.hotelId } },
    data: { isActive: false },
  });

  return NextResponse.json({ mode: "deactivated" });
}
