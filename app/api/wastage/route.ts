import { NextResponse } from "next/server";
import type { WastageReason } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { syncLowStockAlerts } from "@/lib/notifications";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { findActiveHotelStaff } from "@/lib/hotel-staff";

const WASTAGE_REASONS = new Set<WastageReason>([
  "SPOILAGE",
  "EXPIRED",
  "BURNT",
  "DAMAGED",
  "PREP_WASTE",
  "OTHER",
]);

export async function GET() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "INVENTORY");
  if (blocked) return blocked;

  const [wastages, memberships] = await Promise.all([
    prisma.wastage.findMany({
      where: { hotelId: tenant.hotelId },
      include: {
        inventoryItem: { select: { name: true, unit: true, costPerUnit: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.hotelMembership.findMany({
      where: { hotelId: tenant.hotelId, status: "ACTIVE", user: { isActive: true } },
      select: { userId: true, user: { select: { name: true } } },
    }),
  ]);
  const staffNamesByUserId = new Map(memberships.map((membership) => [membership.userId, membership.user.name]));

  return NextResponse.json(
    wastages.map((wastage) => ({
      id: wastage.id,
      itemName: wastage.inventoryItem.name,
      unit: wastage.inventoryItem.unit,
      quantity: Number(wastage.quantity),
      reason: wastage.reason,
      department: wastage.department,
      accountableName: wastage.accountableName ?? "Not recorded (legacy entry)",
      recordedByName: staffNamesByUserId.get(wastage.recordedById) ?? "Former hotel staff",
      createdAt: wastage.createdAt,
      value: Math.round(
        Number(wastage.quantity) * Number(wastage.inventoryItem.costPerUnit)
      ),
    }))
  );
}

// Recording wastage decreases stock and logs a StockMovement, atomically.
// The accountable person is separate from the manager who enters the record:
// for example, a manager can record an egg broken by a chef without making
// the manager appear responsible for the loss.
export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "INVENTORY");
  if (blocked) return blocked;

  const body = await req.json();
  const inventoryItemId =
    typeof body.inventoryItemId === "string" ? body.inventoryItemId.trim() : "";
  const quantity = Number(body.quantity);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const department =
    typeof body.department === "string" ? body.department.trim() : "";
  const requestedAccountableUserId =
    typeof body.accountableUserId === "string"
      ? body.accountableUserId.trim()
      : "";
  const manualAccountableName =
    typeof body.accountableName === "string" ? body.accountableName.trim() : "";

  if (
    !inventoryItemId ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !WASTAGE_REASONS.has(reason as WastageReason)
  ) {
    return NextResponse.json(
      { error: "Item, a positive quantity, and a valid reason are required." },
      { status: 400 }
    );
  }

  let accountableUserId: string | null = null;
  let accountableName = manualAccountableName;
  let accountableDepartment: string | null = null;

  if (requestedAccountableUserId) {
    const accountableStaff = await findActiveHotelStaff(tenant.hotelId, requestedAccountableUserId);
    if (!accountableStaff) {
      return NextResponse.json(
        { error: "Choose an active staff member from this hotel who is accountable for the wastage." },
        { status: 400 }
      );
    }
    accountableUserId = accountableStaff.user.id;
    accountableName = accountableStaff.user.name;
    accountableDepartment = accountableStaff.department;
  }

  if (!accountableName) {
    return NextResponse.json(
      { error: "Choose or enter the person accountable for this wastage." },
      { status: 400 }
    );
  }
  if (accountableName.length > 120) {
    return NextResponse.json(
      { error: "The accountable person's name is too long." },
      { status: 400 }
    );
  }
  if (department.length > 100) {
    return NextResponse.json(
      { error: "The department name is too long." },
      { status: 400 }
    );
  }

  const item = await prisma.inventoryItem.findUnique({
    where: { id_hotelId: { id: inventoryItemId, hotelId: tenant.hotelId } },
  });
  if (!item) {
    return NextResponse.json(
      { error: "Inventory item not found." },
      { status: 404 }
    );
  }

  const before = Number(item.currentStock);
  if (quantity > before) {
    return NextResponse.json(
      {
        error: `Only ${before} ${item.unit} of "${item.name}" in stock — can't log wastage of ${quantity}. If the physical count is actually lower, use Adjust Stock instead.`,
      },
      { status: 400 }
    );
  }
  const after = before - quantity;
  const savedDepartment = department || accountableDepartment || null;

  const [wastage] = await prisma.$transaction([
    prisma.wastage.create({
      data: {
        hotelId: tenant.hotelId,
        inventoryItemId: item.id,
        quantity,
        reason: reason as WastageReason,
        department: savedDepartment,
        recordedById: tenant.userId,
        accountableUserId,
        accountableName,
      },
    }),
    prisma.inventoryItem.update({
      where: { id_hotelId: { id: item.id, hotelId: tenant.hotelId } },
      data: { currentStock: after },
    }),
    prisma.stockMovement.create({
      data: {
        hotelId: tenant.hotelId,
        inventoryItemId: item.id,
        type: "WASTAGE",
        quantity: -quantity,
        beforeQty: before,
        afterQty: after,
        reference: `Wastage: ${reason} — Accountable: ${accountableName}`,
        userId: tenant.userId,
      },
    }),
  ]);

  await syncLowStockAlerts(tenant.hotelId);

  return NextResponse.json(
    { ...wastage, accountableName },
    { status: 201 }
  );
}
