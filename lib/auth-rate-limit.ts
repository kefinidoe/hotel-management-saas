import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getClientIp, UNKNOWN_CLIENT_IP } from "@/lib/client-ip";

// Fixed windows start with the first attempt; rejected attempts do not extend them.
// These are intentionally separate per operation so, for example, a password
// change cannot exhaust a user's login budget.
export const AUTH_RATE_LIMITS = {
  login: { account: 5, ip: 100, seconds: 15 * 60 },
  registration: { account: 5, ip: 100, seconds: 60 * 60 },
  password: { account: 5, ip: 100, seconds: 15 * 60 },
  invitation: { account: 10, ip: 200, seconds: 15 * 60 },
  invitationCreate: { account: 10, actor: 30, ip: 200, seconds: 15 * 60 },
} as const;

type Operation = keyof typeof AUTH_RATE_LIMITS;
type Counter = { attempts: number; retrySeconds: number };

function bucketKey(operation: Operation, kind: string, value: string): string {
  const digest = createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
  return `${operation}:${kind}:${digest}`;
}

/**
 * Atomically count every attempt in PostgreSQL, shared by all application
 * instances. If the store is unavailable, fail closed with 503. Unknown IPs
 * are deliberately not counted in a shared IP bucket.
 */
export async function limitAuthRequest(
  request: Request,
  operation: Operation,
  account: string,
  actor?: string,
): Promise<NextResponse | null> {
  const policy = AUTH_RATE_LIMITS[operation];
  const normalized = account.trim().toLowerCase();
  // Missing account input has its own bucket, not one shared with real users.
  const buckets: Array<{ key: string; limit: number }> = [{ key: bucketKey(operation, "account", normalized || "<missing>"), limit: policy.account }];
  if (operation === "invitationCreate" && actor) {
    buckets.push({ key: bucketKey(operation, "actor", actor), limit: AUTH_RATE_LIMITS.invitationCreate.actor });
  }
  const ip = getClientIp(request);
  if (ip !== UNKNOWN_CLIENT_IP) buckets.push({ key: bucketKey(operation, "ip", ip), limit: policy.ip });

  try {
    const { prisma } = await import("@/lib/prisma");
    // Bounded opportunistic cleanup prevents expired, unique account keys from
    // accumulating indefinitely. SKIP LOCKED avoids blocking competing workers.
    await prisma.$executeRaw`
      DELETE FROM "AuthRateLimitBucket" WHERE "key" IN (
        SELECT "key" FROM "AuthRateLimitBucket"
        WHERE "expiresAt" <= CURRENT_TIMESTAMP
        ORDER BY "expiresAt" LIMIT 16 FOR UPDATE SKIP LOCKED
      ) AND "expiresAt" <= CURRENT_TIMESTAMP
    `;
    let retryAfter = 0;
    for (const bucket of buckets) {
      const rows = await prisma.$queryRaw<Counter[]>`
        INSERT INTO "AuthRateLimitBucket" ("key", "attempts", "expiresAt")
        VALUES (${bucket.key}, 1, CURRENT_TIMESTAMP + (${policy.seconds} * INTERVAL '1 second'))
        ON CONFLICT ("key") DO UPDATE SET
          "attempts" = CASE WHEN "AuthRateLimitBucket"."expiresAt" <= CURRENT_TIMESTAMP
            THEN 1 ELSE LEAST("AuthRateLimitBucket"."attempts" + 1, ${bucket.limit + 1}) END,
          "expiresAt" = CASE WHEN "AuthRateLimitBucket"."expiresAt" <= CURRENT_TIMESTAMP
            THEN CURRENT_TIMESTAMP + (${policy.seconds} * INTERVAL '1 second')
            ELSE "AuthRateLimitBucket"."expiresAt" END
        RETURNING "attempts", GREATEST(1, CEIL(EXTRACT(EPOCH FROM ("expiresAt" - CURRENT_TIMESTAMP))))::INTEGER AS "retrySeconds"
      `;
      if (rows[0].attempts > bucket.limit) retryAfter = Math.max(retryAfter, rows[0].retrySeconds);
    }
    if (retryAfter > 0) {
      return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } });
    }
    return null;
  } catch {
    return NextResponse.json({ error: "RATE_LIMIT_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
