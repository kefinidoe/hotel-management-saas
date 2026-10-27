import { NextResponse } from "next/server";
import { getPlatformAdminFromRoute } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { HotelStatus, PlatformRole } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getPlatformAdminFromRoute();
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Hotel ID is required" }, { status: 400 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const targetStatus = body?.status as HotelStatus | undefined;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  const confirmed = Boolean(body?.confirmed);

  if (!targetStatus || !Object.values(HotelStatus).includes(targetStatus)) {
    return NextResponse.json(
      {
        error: "INVALID_STATUS",
        message: `Status must be one of: ${Object.values(HotelStatus).join(", ")}`,
      },
      { status: 400 }
    );
  }

  try {
    const hotel = await prisma.hotel.findUnique({
      where: { id },
      select: { id: true, name: true, slug: true, status: true },
    });

    if (!hotel) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "Hotel not found" },
        { status: 404 }
      );
    }

    if (hotel.status === targetStatus) {
      return NextResponse.json(
        {
          error: "ALREADY_IN_STATUS",
          message: `Hotel is already in status '${targetStatus}'.`,
        },
        { status: 400 }
      );
    }

    // Lifecycle validation rules:
    // 1. Suspension or cancellation requires explicit operational reason and confirmation
    if (targetStatus === HotelStatus.SUSPENDED || targetStatus === HotelStatus.CANCELLED) {
      if (!confirmed) {
        return NextResponse.json(
          {
            error: "CONFIRMATION_REQUIRED",
            message: `Explicit confirmation is required to transition hotel to ${targetStatus}.`,
          },
          { status: 400 }
        );
      }
      if (!reason || reason.length < 5) {
        return NextResponse.json(
          {
            error: "REASON_REQUIRED",
            message: `An explanatory reason of at least 5 characters is required to transition hotel to ${targetStatus}.`,
          },
          { status: 400 }
        );
      }
    }

    // 2. Reactivating a CANCELLED hotel requires PLATFORM_SUPER_ADMIN privileges
    if (
      hotel.status === HotelStatus.CANCELLED &&
      targetStatus !== HotelStatus.CANCELLED &&
      admin.platformRole !== PlatformRole.PLATFORM_SUPER_ADMIN
    ) {
      return NextResponse.json(
        {
          error: "FORBIDDEN",
          message: "Only Platform Super Administrators can reactivate a cancelled hotel.",
        },
        { status: 403 }
      );
    }

    // Execute status transition and create audit log record atomically
    const [updatedHotel, auditLog] = await prisma.$transaction([
      prisma.hotel.update({
        where: { id: hotel.id },
        data: { status: targetStatus },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          updatedAt: true,
        },
      }),
      prisma.auditLog.create({
        data: {
          hotelId: hotel.id,
          userId: admin.userId,
          action: `HOTEL_STATUS_${targetStatus}`,
          entity: "HOTEL",
          entityId: hotel.id,
          metadata: {
            previousStatus: hotel.status,
            newStatus: targetStatus,
            reason: reason || "Administrative lifecycle update",
            platformRole: admin.platformRole,
          },
        },
      }),
    ]);

    return NextResponse.json({
      success: true,
      message: `Hotel '${updatedHotel.name}' status changed from ${hotel.status} to ${updatedHotel.status}.`,
      hotel: {
        id: updatedHotel.id,
        name: updatedHotel.name,
        slug: updatedHotel.slug,
        status: updatedHotel.status,
        updatedAt: updatedHotel.updatedAt.toISOString(),
      },
      auditLogId: auditLog.id,
    });
  } catch (error) {
    console.error("Failed to update hotel lifecycle status:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "Failed to update hotel lifecycle status." },
      { status: 500 }
    );
  }
}
