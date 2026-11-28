import { NextResponse } from "next/server";
import { getBillingTenantFromRoute, requireRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { ROLE_GROUPS } from "@/lib/permissions";
import {
  buildSubscriptionInvoicePdf,
  serializeSubscriptionInvoice,
} from "@/lib/subscription-invoices";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const tenant = await getBillingTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.STAFF_ADMIN);
  if (forbidden) return forbidden;

  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "INVALID_INVOICE_ID", message: "Invoice ID is required." }, { status: 400 });
  }

  try {
    const invoice = await prisma.subscriptionInvoice.findFirst({
      where: {
        id,
        hotelId: tenant.hotelId,
      },
    });

    if (!invoice) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "Subscription invoice not found." },
        { status: 404 }
      );
    }

    const serialized = serializeSubscriptionInvoice(invoice);
    const { searchParams } = new URL(req.url);
    const format = searchParams.get("format")?.trim().toLowerCase();

    if (format === "pdf") {
      const hotelDetails = await prisma.hotel.findUnique({
        where: { id: tenant.hotelId },
        select: { id: true, name: true, slug: true, email: true, address: true },
      });

      const pdfBytes = await buildSubscriptionInvoicePdf({
        invoice: serialized,
        hotel: {
          id: tenant.hotelId,
          name: hotelDetails?.name || tenant.hotel.name,
          slug: hotelDetails?.slug || tenant.hotel.slug,
          email: hotelDetails?.email ?? null,
          address: hotelDetails?.address ?? null,
        },
      });

      const safeFile = serialized.invoiceNumber.replace(/[^A-Za-z0-9._-]/g, "_");
      return new NextResponse(Buffer.from(pdfBytes), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${safeFile}.pdf"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json({ invoice: serialized });
  } catch (error) {
    console.error("Failed to load subscription invoice:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "Failed to retrieve subscription invoice." },
      { status: 500 }
    );
  }
}
