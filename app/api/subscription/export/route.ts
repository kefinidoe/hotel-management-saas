import { NextResponse } from "next/server";
import { getBillingTenantFromRoute, requireRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { ROLE_GROUPS } from "@/lib/permissions";
import {
  buildTenantExportPayload,
  buildTenantExportPdf,
  buildTenantExportWorkbook,
} from "@/lib/subscription-export";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const tenant = await getBillingTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.STAFF_ADMIN);
  if (forbidden) return forbidden;

  const { searchParams } = new URL(req.url);
  const format = (searchParams.get("format")?.trim().toLowerCase() || "json");
  if (!["json", "xlsx", "pdf"].includes(format)) {
    return NextResponse.json(
      { error: "INVALID_FORMAT", message: "Supported export formats: json, xlsx, pdf." },
      { status: 400 }
    );
  }

  try {
    const payload = await buildTenantExportPayload(tenant.hotelId);
    const safeSlug = payload.hotel.slug.replace(/[^A-Za-z0-9._-]/g, "_") || tenant.hotelId;
    const dateStamp = new Date().toISOString().slice(0, 10);

    if (typeof (prisma as any).auditLog?.create === "function") {
      await prisma.auditLog.create({
        data: {
          hotelId: tenant.hotelId,
          userId: tenant.userId,
          action: "SUBSCRIPTION_DATA_EXPORTED",
          entity: "Subscription",
          entityId: payload.subscription.id,
          metadata: {
            format,
            effectiveStatus: payload.subscription.effectiveStatus,
            roomsCount: payload.rooms.length,
            reservationsCount: payload.reservations.length,
            paymentsCount: payload.payments.length,
          },
        },
      });
    }

    if (format === "xlsx") {
      const workbookBytes = buildTenantExportWorkbook(payload);
      return new NextResponse(Buffer.from(workbookBytes), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${safeSlug}-backup-${dateStamp}.xlsx"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (format === "pdf") {
      const pdfBytes = await buildTenantExportPdf(payload);
      return new NextResponse(Buffer.from(pdfBytes), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${safeSlug}-summary-${dateStamp}.pdf"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeSlug}-backup-${dateStamp}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Failed to export tenant workspace data:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "Failed to export workspace data." },
      { status: 500 }
    );
  }
}
