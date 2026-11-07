import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

// Stable for JSON payloads, including nested objects with different key order.
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

type Result = { status: number; body: unknown };

/** Store successful responses in the same transaction as the inventory effects.
 * Advisory locking serializes same-key requests before reading the durable row;
 * the unique constraint is an additional database-level backstop. */
export async function inventoryRequest(
  req: Request, hotelId: string, actorId: string, operation: string, payload: unknown,
  perform: (tx: Prisma.TransactionClient) => Promise<Result>,
): Promise<NextResponse> {
  const expectedHotel = req.headers.get("x-expected-hotel-id");
  const expectedActor = req.headers.get("x-expected-actor-id");
  if ((expectedHotel && expectedHotel !== hotelId) || (expectedActor && expectedActor !== actorId)) {
    return NextResponse.json({ error: "The active hotel or user changed; recover this request in its original context.", code: "TENANT_CONTEXT_MISMATCH" }, { status: 409 });
  }
  const key = (req.headers.get("idempotency-key") || req.headers.get("x-idempotency-key") || "").trim();
  if (key.length < 4 || key.length > 128) return NextResponse.json({ error: "An idempotency key of 4–128 characters is required." }, { status: 400 });
  const fingerprint = createHash("sha256").update(JSON.stringify(canonical({ actorId, payload }))).digest("hex");
  const outcome = await prisma.$transaction(async (tx) => {
    const lockKey = JSON.stringify([hotelId, operation, key]);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked`;
    const where = { hotelId_operation_requestKey: { hotelId, operation, requestKey: key } };
    const previous = await tx.inventoryRequest.findUnique({ where });
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { status: 409, body: { error: "Idempotency key was already used for a different request." } };
      return { status: previous.statusCode, body: previous.response };
    }
    const result = await perform(tx);
    if (result.status >= 200 && result.status < 300) {
      // Prisma JSON input must not contain Decimal, Date or undefined instances.
      const response = JSON.parse(JSON.stringify(result.body)) as Prisma.InputJsonValue;
      await tx.inventoryRequest.create({ data: { hotelId, operation, requestKey: key, fingerprint, response, statusCode: result.status } });
      return { status: result.status, body: response };
    }
    return result;
  });
  return NextResponse.json(outcome.body, { status: outcome.status });
}
