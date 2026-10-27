import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { getStockStatus } from "@/lib/inventory";

export async function GET(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const { checkModuleEntitlement } = await import("@/lib/entitlements");
  const moduleCheck = await checkModuleEntitlement(tenant.hotelId, "INVENTORY");
  if (!moduleCheck.allowed) {
    return NextResponse.json(
      { error: moduleCheck.code || "MODULE_NOT_ENTITLED", message: moduleCheck.reason },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(req.url);
  const includeInactive = searchParams.get("includeInactive") === "true";

  const items = await prisma.inventoryItem.findMany({
    where: {
      hotelId: tenant.hotelId,
      ...(includeInactive ? {} : { isActive: true }),
    },
    orderBy: { name: "asc" },
  });

  return NextResponse.json(
    items.map((i) => {
      const currentStock = Number(i.currentStock);
      const reorderLevel = Number(i.reorderLevel);
      const costPerUnit = Number(i.costPerUnit);
      return {
        id: i.id,
        sku: i.sku,
        name: i.name,
        category: i.category,
        unit: i.unit,
        currentStock,
        reorderLevel,
        costPerUnit,
        supplier: i.supplier,
        isActive: i.isActive,
        stockValue: Math.round(currentStock * costPerUnit),
        status: getStockStatus(currentStock, reorderLevel),
      };
    })
  );
}

export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const { checkModuleEntitlement } = await import("@/lib/entitlements");
  const moduleCheck = await checkModuleEntitlement(tenant.hotelId, "INVENTORY");
  if (!moduleCheck.allowed) {
    return NextResponse.json(
      { error: moduleCheck.code || "MODULE_NOT_ENTITLED", message: moduleCheck.reason },
      { status: 403 }
    );
  }

  const body = await req.json();
  const { sku, name, category, unit, currentStock, reorderLevel, costPerUnit, supplier } = body;

  if (!sku || !name || !category || !unit) {
    return NextResponse.json(
      { error: "SKU, name, category, and unit are required." },
      { status: 400 }
    );
  }
  if (!["g", "ml", "pcs"].includes(unit)) {
    return NextResponse.json({ error: "Unit must be g, ml, or pcs." }, { status: 400 });
  }

  const opening = Number(currentStock) || 0;

  try {
    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.inventoryItem.create({
        data: {
          hotelId: tenant.hotelId,
          sku,
          name,
          category,
          unit,
          currentStock: opening,
          reorderLevel: reorderLevel ?? 0,
          costPerUnit: costPerUnit ?? 0,
          supplier: supplier || null,
        },
      });

      if (opening > 0) {
        await tx.stockMovement.create({
          data: {
            hotelId: tenant.hotelId,
            inventoryItemId: created.id,
            type: "OPENING_BALANCE",
            quantity: opening,
            beforeQty: 0,
            afterQty: opening,
            reference: "Item created",
            userId: tenant.userId,
          },
        });
      }

      return created;
    });

    return NextResponse.json(item, { status: 201 });
  } catch {
    return NextResponse.json({ error: "An item with that SKU already exists." }, { status: 400 });
  }
}