import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { isMealPlan } from "@/lib/tariffs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;

  const roomType = await prisma.roomType.findUnique({
    where: { id_hotelId: { id, hotelId } },
  });

  if (!roomType) {
    return NextResponse.json({ error: "Room type not found." }, { status: 404 });
  }

  return NextResponse.json({ ...roomType, baseRate: Number(roomType.baseRate) });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;

  const existing = await prisma.roomType.findUnique({
    where: { id_hotelId: { id, hotelId } },
  });
  if (!existing) {
    return NextResponse.json({ error: "Room type not found." }, { status: 404 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = typeof body?.name === "string" ? body.name.trim() : existing.name;
  const baseRate = body?.baseRate !== undefined ? Number(body.baseRate) : Number(existing.baseRate);

  if (isNaN(baseRate) || baseRate < 0) {
    return NextResponse.json({ error: "Base rate must be a valid positive number." }, { status: 400 });
  }

  const mealPlan = body?.mealPlan !== undefined
    ? (isMealPlan(body.mealPlan) ? body.mealPlan : null)
    : existing.mealPlan;

  const roomType = await prisma.roomType.update({
    where: { id_hotelId: { id, hotelId } },
    data: {
      name,
      description: body.description !== undefined ? (body.description ? String(body.description).trim() : null) : existing.description,
      baseRate,
      capacity: typeof body.capacity === "number" && body.capacity > 0 ? body.capacity : existing.capacity,
      mealPlan,
    },
  });
  return NextResponse.json({ ...roomType, baseRate: Number(roomType.baseRate) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;

  const existing = await prisma.roomType.findUnique({
    where: { id_hotelId: { id, hotelId } },
    include: {
      rooms: {
        where: { hotelId },
        take: 1,
      },
    },
  });

  if (!existing) {
    return NextResponse.json({ error: "Room type not found." }, { status: 404 });
  }

  if (existing.rooms.length > 0) {
    return NextResponse.json(
      { error: "Can't delete a room type that still has rooms assigned to it." },
      { status: 400 }
    );
  }

  try {
    await prisma.roomType.delete({
      where: { id_hotelId: { id, hotelId } },
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Can't delete a room type that still has rooms assigned to it." },
      { status: 400 }
    );
  }
}
