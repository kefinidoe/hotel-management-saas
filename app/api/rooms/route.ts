import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";

export async function GET() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.ALL_STAFF);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;

  const rooms = await prisma.room.findMany({
    where: { hotelId, isActive: true },
    include: {
      roomType: {
        select: {
          id: true,
          hotelId: true,
          name: true,
          description: true,
          baseRate: true,
          capacity: true,
          mealPlan: true,
          amenities: true,
        },
      },
    },
    orderBy: { number: "asc" },
  });

  return NextResponse.json(
    rooms.map((r) => ({
      ...r,
      roomType: { ...r.roomType, baseRate: Number(r.roomType.baseRate) },
    }))
  );
}

export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const roomNumber = typeof body?.number === "string" ? body.number.trim() : "";
  const roomTypeId = typeof body?.roomTypeId === "string" ? body.roomTypeId.trim() : "";

  if (!roomNumber || !roomTypeId) {
    return NextResponse.json(
      { error: "Room number and room type are required." },
      { status: 400 }
    );
  }

  // Enforce SaaS Subscription Plan Room Limit
  const { checkUsageLimit } = await import("@/lib/entitlements");
  const roomLimit = await checkUsageLimit(hotelId, "maxRooms", 1);
  if (!roomLimit.allowed) {
    return NextResponse.json(
      {
        error: roomLimit.code || "PLAN_LIMIT_EXCEEDED",
        message: roomLimit.reason,
      },
      { status: 403 }
    );
  }

  // Tenant Isolation Verification: Validate that the referenced roomTypeId belongs to THIS hotel
  const roomType = await prisma.roomType.findUnique({
    where: { id_hotelId: { id: roomTypeId, hotelId } },
  });

  if (!roomType) {
    return NextResponse.json(
      { error: "Referenced room type does not exist in this hotel." },
      { status: 400 }
    );
  }

  try {
    const room = await prisma.room.create({
      data: {
        hotelId,
        number: roomNumber,
        floor: body.floor ? String(body.floor).trim() : null,
        roomTypeId,
      },
      include: {
        roomType: {
          select: {
            id: true,
            hotelId: true,
            name: true,
            description: true,
            baseRate: true,
            capacity: true,
            mealPlan: true,
            amenities: true,
          },
        },
      },
    });
    return NextResponse.json(
      {
        ...room,
        roomType: { ...room.roomType, baseRate: Number(room.roomType.baseRate) },
      },
      { status: 201 }
    );
  } catch (error: any) {
    if (error?.code === "P2002") {
      return NextResponse.json(
        { error: "A room with that number already exists in this hotel." },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: "Failed to create room." }, { status: 500 });
  }
}
