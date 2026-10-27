import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getTenantFromRoute } from "@/lib/authz";
import { CheckOutError, executeCheckOut } from "@/lib/stay-service";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

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
    const result = await executeCheckOut(tenant, {
      reservationId: id,
      allowOutstandingBalance: body?.allowOutstandingBalance === true,
    });

    if (result instanceof NextResponse) return result;

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof CheckOutError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return NextResponse.json(
        { error: "The folio changed during checkout. Refresh and try again." },
        { status: 409 }
      );
    }
    console.error("Check-out failed:", error);
    return NextResponse.json({ error: "Could not complete checkout." }, { status: 500 });
  }
}
