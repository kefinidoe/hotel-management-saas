import { NextResponse } from "next/server";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.RESTAURANT_POS);
  if (forbidden) return forbidden;

  const { searchParams } = new URL(req.url);
  const idempotencyKey = searchParams.get("key")?.trim();
  const fingerprint = searchParams.get("fingerprint")?.trim();

  if (!idempotencyKey || idempotencyKey.length < 4 || idempotencyKey.length > 128) {
    return NextResponse.json(
      { error: "A valid idempotency key (4-128 characters) is required.", code: "INVALID_IDEMPOTENCY_KEY" },
      { status: 400 }
    );
  }

  try {
    const payment = await prisma.payment.findUnique({
      where: {
        hotelId_idempotencyKey: {
          hotelId: tenant.hotelId,
          idempotencyKey,
        },
      },
      include: {
        folio: { include: { guest: { select: { fullName: true } } } },
        paymentMethod: { select: { name: true } },
      },
    });

    if (!payment) {
      return NextResponse.json({
        found: false,
        status: "NOT_FOUND",
        message: "No recorded payment exists for this idempotency key in this hotel.",
      });
    }

    const matchesFingerprint = !fingerprint || payment.requestFingerprint === fingerprint;

    return NextResponse.json({
      found: true,
      status: payment.status,
      matchesFingerprint,
      paymentId: payment.id,
      folioId: payment.folioId,
      guestName: payment.folio?.guest?.fullName ?? "Walk-in Guest",
      method: payment.paymentMethod?.name ?? "Unknown",
      total: Number(payment.amount),
      createdAt: payment.createdAt
        ? (typeof payment.createdAt.toISOString === "function"
            ? payment.createdAt.toISOString()
            : new Date(payment.createdAt).toISOString())
        : new Date().toISOString(),
      isIdempotentReplay: true,
    });
  } catch (error) {
    console.error("Failed to query payment status by idempotency key:", error);
    return NextResponse.json(
      { error: "Could not query payment status.", code: "SERVER_ERROR" },
      { status: 500 }
    );
  }
}
