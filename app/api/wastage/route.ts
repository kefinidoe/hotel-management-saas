import { NextResponse } from "next/server";
import { Prisma, type WastageReason } from "@prisma/client";
import Decimal from "decimal.js";
import { roundMoneyDecimal } from "@/lib/billing";
import { prisma } from "@/lib/prisma";
import { syncLowStockAlerts } from "@/lib/notifications";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { findActiveHotelStaff } from "@/lib/hotel-staff";
import { inventoryRequest } from "@/lib/inventory-idempotency";

const WASTAGE_REASONS = new Set<WastageReason>([
  "SPOILAGE",
  "EXPIRED",
  "BURNT",
  "DAMAGED",
  "PREP_WASTE",
  "OTHER",
]);

export async function GET() {
  const tenant = await getTenantFromRoute("read");
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "INVENTORY", "read");
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
      value: roundMoneyDecimal(
        new Decimal(String(wastage.quantity)).mul(String(wastage.inventoryItem.costPerUnit))
      ).toNumber(),
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

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }
  const inventoryItemId =
    typeof body.inventoryItemId === "string" ? body.inventoryItemId.trim() : "";
  let parsedQty: Prisma.Decimal | null = null;
  try {
    if (
      (typeof body.quantity === "number" && Number.isFinite(body.quantity)) ||
      (typeof body.quantity === "string" && body.quantity.trim() !== "")
    ) {
      parsedQty = new Prisma.Decimal(
        typeof body.quantity === "string" ? body.quantity.trim() : body.quantity
      );
    }
  } catch {
    parsedQty = null;
  }
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
    !parsedQty ||
    !parsedQty.isFinite() ||
    parsedQty.lte(0) ||
    parsedQty.decimalPlaces() > 2 ||
    !WASTAGE_REASONS.has(reason as WastageReason)
  ) {
    return NextResponse.json(
      { error: "Item, a positive quantity, and a valid reason are required." },
      { status: 400 }
    );
  }

  if (!requestedAccountableUserId && !manualAccountableName) {
    return NextResponse.json({ error: "Choose or enter the person accountable for this wastage." }, { status: 400 });
  }
  if (manualAccountableName.length > 120 || department.length > 100) {
    return NextResponse.json({ error: "Accountable name or department is too long." }, { status: 400 });
  }

  const amount = parsedQty;
  // The conditional decrement locks the item row and rechecks the balance in
  // the database. All related records use that same transaction and row lock.
  const response = await inventoryRequest(req, tenant.hotelId, tenant.userId, "WASTAGE", body, async (tx) => {
    let accountableUserId: string | null = null;
    let accountableName = manualAccountableName;
    let accountableDepartment: string | null = null;
    if (requestedAccountableUserId) {
      const staff = await findActiveHotelStaff(tenant.hotelId, requestedAccountableUserId, tx);
      if (!staff) return { status: 400, body: { error: "Choose an active staff member from this hotel who is accountable for the wastage." } };
      accountableUserId = staff.user.id;
      accountableName = staff.user.name;
      accountableDepartment = staff.department;
    }
    if (!accountableName || accountableName.length > 120) return { status: 400, body: { error: "Invalid accountable person name." } };
    const savedDepartment = department || accountableDepartment || null;
    const changed = await tx.inventoryItem.updateMany({
      where: { id: inventoryItemId, hotelId: tenant.hotelId, currentStock: { gte: amount } },
      data: { currentStock: { decrement: amount }, stockVersion: { increment: 1 } },
    });
    if (changed.count !== 1) {
      const item = await tx.inventoryItem.findUnique({
        where: { id_hotelId: { id: inventoryItemId, hotelId: tenant.hotelId } },
      });
      return { body: { error: item ? "Insufficient stock for this wastage." : "Inventory item not found." }, status: item ? 400 : 404 };
    }
    const item = await tx.inventoryItem.findUniqueOrThrow({
      where: { id_hotelId: { id: inventoryItemId, hotelId: tenant.hotelId } },
    });
    const after = item.currentStock;
    const before = after.add(amount);
    const wastage = await tx.wastage.create({
      data: {
        hotelId: tenant.hotelId, inventoryItemId: item.id, quantity: amount,
        reason: reason as WastageReason, department: savedDepartment,
        recordedById: tenant.userId, accountableUserId, accountableName,
      },
    });
    await tx.stockMovement.create({
      data: {
        hotelId: tenant.hotelId, inventoryItemId: item.id, type: "WASTAGE",
        quantity: amount.negated(), beforeQty: before, afterQty: after,
        reference: `Wastage: ${reason} — Accountable: ${accountableName}`,
        userId: tenant.userId,
      },
    });
    return { status: 201, body: { ...wastage, accountableName } };
  });

  if (response.ok) await syncLowStockAlerts(tenant.hotelId);
  return response;
}
