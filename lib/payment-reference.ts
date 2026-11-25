import { prisma } from "@/lib/prisma";

// Check both indexed and unindexed legacy rows using the same normalization as
// the database trigger. Call only after an aborted payment transaction; this is
// for accurate error reporting, not the concurrency or authorization boundary.
export async function paymentReferenceExists(hotelId: string, reference: string): Promise<boolean> {
  if (!reference.trim()) return false;
  const rows = await prisma.$queryRaw<Array<{ found: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM "Payment" WHERE "hotelId" = ${hotelId}
      AND NULLIF(upper(btrim(reference)), '') = NULLIF(upper(btrim(${reference})), '')) AS found
  `;
  return rows[0]?.found === true;
}
