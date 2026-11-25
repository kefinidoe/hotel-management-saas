import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getTenantFromRoute, requireModule } from "@/lib/authz";
import { CheckInError, executeCheckIn } from "@/lib/stay-service";
import { paymentReferenceExists } from "@/lib/payment-reference";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  // Enforce SaaS Subscription Plan Module Entitlement
  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  let body: any = {};
  try {
    const text = await req.text();
    if (text) {
      body = JSON.parse(text);
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const result = await executeCheckIn(tenant, {
      reservationId: id,
      amountPaid: body?.amountPaid,
      paymentMethodId: body?.paymentMethodId,
      reference: body?.reference,
      newRoomId: body?.newRoomId,
    });

    if (result instanceof NextResponse) return result;

    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    if (error instanceof CheckInError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code) && typeof body?.reference === "string") {
      try {
        if (await paymentReferenceExists(tenant.hotelId, body.reference)) return NextResponse.json({ error: "This payment reference has already been recorded for this hotel." }, { status: 409 });
      } catch (lookupError) { console.error("Failed to inspect payment reference conflict:", lookupError); }
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return NextResponse.json(
        { error: "This reservation changed while checking in. Refresh and try again." },
        { status: 409 }
      );
    }
    console.error("Check-in failed:", error);
    return NextResponse.json({ error: "Could not check in the guest." }, { status: 500 });
  }
}
