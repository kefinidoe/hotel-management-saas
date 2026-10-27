import { Prisma, RoomStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";

const ACTIVE_RESERVATION_STATUSES = ["PENDING", "CONFIRMED", "CHECKED_IN"] as const;

class RoomRemovalError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.ALL_STAFF);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;

  const room = await prisma.room.findUnique({
    where: { id_hotelId: { id, hotelId } },
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

  if (!room) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }

  return NextResponse.json({
    ...room,
    roomType: { ...room.roomType, baseRate: Number(room.roomType.baseRate) },
  });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;

  const existing = await prisma.room.findUnique({
    where: { id_hotelId: { id, hotelId } },
  });
  if (!existing) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const roomNumber = typeof body?.number === "string" ? body.number.trim() : existing.number;
  const roomTypeId = typeof body?.roomTypeId === "string" ? body.roomTypeId.trim() : existing.roomTypeId;

  // Tenant Isolation Verification: Validate roomTypeId belongs to THIS hotel
  if (roomTypeId !== existing.roomTypeId) {
    const validRoomType = await prisma.roomType.findUnique({
      where: { id_hotelId: { id: roomTypeId, hotelId } },
    });
    if (!validRoomType) {
      return NextResponse.json(
        { error: "Referenced room type does not exist in this hotel." },
        { status: 400 }
      );
    }
  }

  // Validate status transition if status is provided
  let newStatus = existing.status;
  if (body.status && Object.values(RoomStatus).includes(body.status)) {
    // If room currently has active reservation or stay, protect against accidental invalid status override
    if (body.status !== existing.status && (existing.status === RoomStatus.OCCUPIED || existing.status === RoomStatus.RESERVED)) {
      if (body.status === RoomStatus.AVAILABLE || body.status === RoomStatus.OUT_OF_ORDER) {
        const activeStay = await prisma.reservationRoom.findFirst({
          where: {
            roomId: id,
            reservation: {
              hotelId,
              status: { in: [...ACTIVE_RESERVATION_STATUSES] },
            },
          },
          include: { reservation: true },
        });
        if (activeStay) {
          return NextResponse.json(
            {
              error: `Cannot change room status to ${body.status} while reservation ${activeStay.reservation.code} is active.`,
            },
            { status: 409 }
          );
        }
      }
    }
    newStatus = body.status as RoomStatus;
  }

  // Quota enforcement: Reactivating an inactive room increases active room count
  if (body.isActive === true && existing.isActive === false) {
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
  }

  try {
    const room = await prisma.room.update({
      where: { id_hotelId: { id, hotelId } },
      data: {
        number: roomNumber,
        floor: body.floor !== undefined ? (body.floor ? String(body.floor).trim() : null) : existing.floor,
        roomTypeId,
        status: newStatus,
        isActive: body.isActive !== undefined ? Boolean(body.isActive) : undefined,
        notes: body.notes !== undefined ? (body.notes ? String(body.notes).trim() : null) : existing.notes,
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
    return NextResponse.json({
      ...room,
      roomType: { ...room.roomType, baseRate: Number(room.roomType.baseRate) },
    });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return NextResponse.json(
        { error: "A room with that number already exists in this hotel." },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: "Failed to update room." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;

  try {
    const room = await prisma.$transaction(
      async (tx) => {
        // Hotel-scoped advisory lock to prevent race conditions during reservation creation
        const lockKey = `hotel-${hotelId}-reservation-create`;
        await tx.$queryRaw<Array<{ locked: string }>>`
          SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked
        `;

        const existing = await tx.room.findUnique({
          where: { id_hotelId: { id, hotelId } },
          select: {
            id: true,
            hotelId: true,
            number: true,
            isActive: true,
            reservationRooms: {
              where: {
                reservation: {
                  hotelId,
                  status: { in: [...ACTIVE_RESERVATION_STATUSES] },
                },
              },
              select: {
                reservation: { select: { code: true, status: true } },
              },
              take: 1,
            },
          },
        });

        if (!existing) throw new RoomRemovalError("Room not found.", 404);
        if (!existing.isActive) return existing;

        const blockingReservation = existing.reservationRooms[0]?.reservation;
        if (blockingReservation) {
          throw new RoomRemovalError(
            `Room ${existing.number} cannot be removed while reservation ${blockingReservation.code} is ${blockingReservation.status.toLowerCase().replace("_", " ")}.`,
            409
          );
        }

        return tx.room.update({
          where: { id_hotelId: { id, hotelId } },
          data: { isActive: false, status: "OUT_OF_ORDER" },
          select: { id: true, number: true, isActive: true },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
      }
    );

    return NextResponse.json({ ok: true, room });
  } catch (error) {
    if (error instanceof RoomRemovalError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return NextResponse.json(
        { error: "The room changed at the same time. Refresh and try again." },
        { status: 409 }
      );
    }
    console.error("Room removal failed:", error);
    return NextResponse.json({ error: "Could not remove the room." }, { status: 500 });
  }
}
