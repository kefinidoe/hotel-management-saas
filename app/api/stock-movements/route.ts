import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";

export async function GET(req: Request) {
  const tenant = await getTenantFromRoute("read");
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "INVENTORY", "read");
  if (blocked) return blocked;

  const { searchParams } = new URL(req.url);
  const requestedItemId = searchParams.get("itemId")?.trim();
  const hotelId = tenant.hotelId;

  if (requestedItemId) {
    const item = await prisma.inventoryItem.findFirst({
      where: { id: requestedItemId, hotelId },
      select: { id: true },
    });
    if (!item) return NextResponse.json({ error: "Inventory item not found." }, { status: 404 });
  }

  const movements = await prisma.stockMovement.findMany({
    where: {
      hotelId,
      ...(requestedItemId ? { inventoryItemId: requestedItemId } : {}),
    },
    include: {
      inventoryItem: true,
      user: {
        select: {
          name: true,
          memberships: {
            where: { hotelId, status: "ACTIVE" },
            select: { id: true },
            take: 1,
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json(
    movements.map((movement) => ({
      id: movement.id,
      itemName: movement.inventoryItem.name,
      unit: movement.inventoryItem.unit,
      type: movement.type,
      quantity: Number(movement.quantity),
      beforeQty: Number(movement.beforeQty),
      afterQty: Number(movement.afterQty),
      reference: movement.reference,
      userName:
        movement.user?.memberships.length
          ? movement.user.name
          : "Former staff",
      createdAt: movement.createdAt,
    }))
  );
}
