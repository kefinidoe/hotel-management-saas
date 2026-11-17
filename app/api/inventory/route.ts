import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { inventoryRequest } from "@/lib/inventory-idempotency";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { getStockStatus } from "@/lib/inventory";

export async function GET(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "INVENTORY");
  if (blocked) return blocked;

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
        stockVersion: i.stockVersion,
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

  const blocked = await requireModule(tenant.hotelId, "INVENTORY");
  if (blocked) return blocked;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const { sku, name, category, unit, currentStock, reorderLevel, costPerUnit, supplier } = body;

  if (!sku || !name || !category || !unit) {
    return NextResponse.json(
      { error: "SKU, name, category, and unit are required." },
      { status: 400 }
    );
  }
  if (![sku, name, category].every((value) => typeof value === "string" && value.trim())) return NextResponse.json({ error: "SKU, name, and category must be valid strings." }, { status: 400 });
  if (!["g", "ml", "pcs"].includes(unit)) {
    return NextResponse.json({ error: "Unit must be g, ml, or pcs." }, { status: 400 });
  }

  const opening = currentStock == null || currentStock === "" ? 0 : Number(currentStock);
  if (!Number.isFinite(opening) || opening < 0 || !new Prisma.Decimal(opening).mul(100).isInteger()) {
    return NextResponse.json({ error: "Opening stock must be non-negative with at most two decimal places." }, { status: 400 });
  }

  const reorder = reorderLevel == null || reorderLevel === "" ? 0 : Number(reorderLevel);
  const cost = costPerUnit == null || costPerUnit === "" ? 0 : Number(costPerUnit);
  if (!Number.isFinite(reorder) || reorder < 0 || !new Prisma.Decimal(reorder).mul(100).isInteger() ||
      !Number.isFinite(cost) || cost < 0 || !new Prisma.Decimal(cost).mul(10000).isInteger()) {
    return NextResponse.json({ error: "Reorder level or unit cost is invalid." }, { status: 400 });
  }

  try {
    return await inventoryRequest(req, tenant.hotelId, tenant.userId, "OPENING_BALANCE", body, async (tx) => {
      const created = await tx.inventoryItem.create({
        data: {
          hotelId: tenant.hotelId,
          sku,
          name,
          category,
          unit,
          currentStock: opening,
          reorderLevel: reorder,
          costPerUnit: cost,
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

      return { status: 201, body: created };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return NextResponse.json({ error: "An item with that SKU already exists." }, { status: 409 });
    throw error;
  }
}