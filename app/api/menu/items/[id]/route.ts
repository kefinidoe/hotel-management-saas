import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;
  const blocked = await requireModule(tenant.hotelId, "RESTAURANT_POS");
  if (blocked) return blocked;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const name = body.name === undefined ? undefined : typeof body.name === "string" ? body.name.trim() : "";
  const price = body.price === undefined ? undefined : Number(body.price);
  if (body.name !== undefined && !name) {
    return NextResponse.json({ error: "Item name is required." }, { status: 400 });
  }
  if (price !== undefined && (!Number.isFinite(price) || price < 0)) {
    return NextResponse.json({ error: "Enter a valid non-negative price." }, { status: 400 });
  }

  const updated = await prisma.menuItem.updateMany({
    where: { id, hotelId: tenant.hotelId },
    data: { name, price },
  });
  if (updated.count === 0) return NextResponse.json({ error: "Menu item not found." }, { status: 404 });
  return NextResponse.json({ id });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;
  const blocked = await requireModule(tenant.hotelId, "RESTAURANT_POS");
  if (blocked) return blocked;

  const updated = await prisma.menuItem.updateMany({
    where: { id, hotelId: tenant.hotelId },
    data: { isActive: false },
  });
  if (updated.count === 0) return NextResponse.json({ error: "Menu item not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
