import { PrismaClient } from "@prisma/client";
import { assertDatabaseSafety } from "./db-safety-guard";
import { assertPricingDelegates } from "./pricing/delegates";

const PRISMA_ALLOWED_PARAMS = new Set([
  "schema",
  "connection_limit",
  "pool_timeout",
  "connect_timeout",
  "socket_timeout",
  "sslmode",
  "sslcert",
  "sslidentity",
  "sslpassword",
  "sslaccept",
  "pgbouncer",
  "statement_cache_size",
  "application_name",
]);

function normalizeDatabaseUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  let cleaned = raw.trim();
  // Strip accidental KEY= prefix if pasted from .env
  cleaned = cleaned.replace(/^(DATABASE_URL|DIRECT_URL)\s*=\s*/i, "").trim();
  // Strip surrounding or stray quotes
  cleaned = cleaned.replace(/^["']+|["']+$/g, "").trim();

  try {
    const parsed = new URL(cleaned);
    const cleanParams = new URLSearchParams();

    parsed.searchParams.forEach((val, key) => {
      const cleanKey = key.replace(/^["']+|["']+$/g, "").trim();
      const cleanVal = val.replace(/^["']+|["']+$/g, "").trim();
      if (PRISMA_ALLOWED_PARAMS.has(cleanKey) && cleanVal) {
        cleanParams.set(cleanKey, cleanVal);
      }
    });

    // If using Supabase transaction pooler (port 6543), ensure pgbouncer=true
    if (parsed.port === "6543" && !cleanParams.has("pgbouncer")) {
      cleanParams.set("pgbouncer", "true");
    }

    if (!cleanParams.has("schema")) {
      cleanParams.set("schema", "public");
    }

    parsed.search = cleanParams.toString();
    return parsed.toString();
  } catch {
    return cleaned;
  }
}

const normalizedUrl = normalizeDatabaseUrl(process.env.DATABASE_URL);
if (normalizedUrl) {
  process.env.DATABASE_URL = normalizedUrl;
}

// Enforce fail-closed database safety guard
// Prevents any connection to production or unverified databases
if (process.env.DATABASE_URL) {
  assertDatabaseSafety();
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    ...(normalizedUrl ? { datasources: { db: { url: normalizedUrl } } } : {}),
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// Fail fast, and say why, when the generated client is older than the schema.
//
// A client generated before the pricing models existed still answers for
// `prisma.hotel`, so the process starts happily and then dies inside a page with
// `TypeError: Cannot read properties of undefined (reading 'findUnique')`. The
// check below costs eleven property reads, runs once per process, and turns that
// unreadable crash into a named error telling the operator to run
// `npx prisma generate` and restart. It is deliberately at start-up as well as in
// the pricing readers: pricing must never run on a client it cannot trust.
assertPricingDelegates(prisma, "application start-up");
