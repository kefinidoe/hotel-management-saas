import { validateRoomStayMutation, roomCreateSchema } from "@/lib/room-stay-mutation-validation";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";

export async function GET() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.ALL_STAFF);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

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

  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  const validation = await validateRoomStayMutation(req, roomCreateSchema, {});
  if (validation.response) return validation.response;
  const body = validation.data;

  const hotelId = tenant.hotelId;


  const roomNumber = typeof body?.number === "string" ? body.number.trim() : "";
  const roomTypeId = typeof body?.roomTypeId === "string" ? body.roomTypeId.trim() : "";

  if (!roomNumber || !roomTypeId) {
    return NextResponse.json(
      { error: "Room number and room type are required." },
      { status: 400 }
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
    const { withUsageLimitLock } = await import("@/lib/entitlements");
    const result = await withUsageLimitLock(hotelId, "maxRooms", 1, async (tx) => tx.room.create({
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
    }));
    if (!result.allowed) {
      return NextResponse.json(
        { error: result.limit.code || "PLAN_LIMIT_EXCEEDED", message: result.limit.reason },
        { status: result.limit.code === "SUBSCRIPTION_STATUS_UNAVAILABLE" || result.limit.code === "USAGE_LIMIT_UNAVAILABLE" ? 503 : 403 }
      );
    }
    const room = result.value;
    return NextResponse.json(
      { ...room, roomType: { ...room.roomType, baseRate: Number(room.roomType.baseRate) } },
      { status: 201 }
    );
  } catch (error: any) {
    if (error?.code === "SUBSCRIPTION_STATUS_UNAVAILABLE" || error?.code === "USAGE_LIMIT_UNAVAILABLE") {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 503 });
    }
    if (error?.code === "P2002") {
      return NextResponse.json(
        { error: "A room with that number already exists in this hotel." },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: "Failed to create room." }, { status: 500 });
  }
}
