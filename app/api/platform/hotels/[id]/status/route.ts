import { NextResponse } from "next/server";
import { getPlatformAdminFromRoute } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { HotelStatus, PlatformRole } from "@prisma/client";
import { z } from "zod";

export const dynamic = "force-dynamic";

const statusBodySchema = z.strictObject({
  status: z.nativeEnum(HotelStatus),
  reason: z.string().trim().max(1000).optional(),
  confirmed: z.boolean().optional(),
});
const emptyQuerySchema = z.strictObject({});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getPlatformAdminFromRoute();
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const idResult = z.string().trim().min(1).max(200).safeParse(id);
  const queryResult = emptyQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!idResult.success || !queryResult.success) {
    return NextResponse.json({ error: "INVALID_REQUEST", issues: [
      ...(!idResult.success ? idResult.error.issues.map((issue) => ({ ...issue, path: ["id", ...issue.path] })) : []),
      ...(!queryResult.success ? queryResult.error.issues : []),
    ] }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = statusBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({
      error: parsed.error.issues.some((issue) => issue.path[0] === "status") ? "INVALID_STATUS" : "INVALID_REQUEST_BODY",
      issues: parsed.error.issues,
    }, { status: 400 });
  }
  const targetStatus = parsed.data.status;
  const reason = parsed.data.reason ?? "";
  const confirmed = parsed.data.confirmed === true;

  // Confirmation and reason are security requirements; check them before
  // looking up the target hotel so malformed requests cannot reach business data.
  if (targetStatus === HotelStatus.SUSPENDED || targetStatus === HotelStatus.CANCELLED) {
    if (!confirmed) {
      return NextResponse.json({ error: "CONFIRMATION_REQUIRED", message: `Explicit confirmation is required to transition hotel to ${targetStatus}.`, issues: [{ code: "custom", path: ["confirmed"], message: "Must be true for suspension or cancellation." }] }, { status: 400 });
    }
    if (reason.length < 5) {
      return NextResponse.json({ error: "REASON_REQUIRED", message: `An explanatory reason of at least 5 characters is required to transition hotel to ${targetStatus}.`, issues: [{ code: "custom", path: ["reason"], message: "Must contain at least 5 characters." }] }, { status: 400 });
    }
  }

  try {
    const hotel = await prisma.hotel.findUnique({
      where: { id: idResult.data },
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

    // Reactivating a CANCELLED hotel requires PLATFORM_SUPER_ADMIN privileges
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
