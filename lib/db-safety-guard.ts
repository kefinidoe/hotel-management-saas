/**
 * Fail-Closed Database Safety Guard for Hotel Management SaaS.
 *
 * Ensures that under NO circumstance can the application, Prisma client,
 * migration scripts, or maintenance tools connect to an unverified database
 * or the legacy single-tenant production database.
 */

export class DatabaseSafetyError extends Error {
  constructor(message: string) {
    super(`[CRITICAL DATABASE SAFETY VIOLATION] ${message}`);
    this.name = "DatabaseSafetyError";
  }
}

export interface DatabaseTargetMetadata {
  protocol: string;
  host: string;
  port: string;
  database: string;
  userPrefix?: string;
  identifierMatched: string;
}

export interface DatabaseSafetyConfig {
  saasEnvironment?: string;
  saasDatabaseIdentifier?: string;
  databaseUrl?: string;
  directUrl?: string;
}

/** Runtime availability check for offline-preview and API error handling. */
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function extractSafeMetadata(rawUrl: string): {
  protocol: string;
  hostname: string;
  port: string;
  databaseName: string;
  usernamePrefix?: string;
} {
  let cleaned = rawUrl.trim().replace(/^(DATABASE_URL|DIRECT_URL)\s*=\s*/i, "").trim();
  cleaned = cleaned.replace(/^["']+|["']+$/g, "").trim();

  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new DatabaseSafetyError(
      "The provided database connection string is malformed and cannot be parsed as a valid URL."
    );
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new DatabaseSafetyError(
      `Unsupported database protocol '${parsed.protocol}'. Expected 'postgres:' or 'postgresql:'.`
    );
  }

  if (!parsed.hostname || parsed.hostname.trim() === "") {
    throw new DatabaseSafetyError("Database URL has no host component.");
  }

  const databaseName = parsed.pathname.replace(/^\//, "");
  if (!databaseName) {
    throw new DatabaseSafetyError("Database URL has no database name component.");
  }

  let usernamePrefix: string | undefined;
  if (parsed.username) {
    const userParts = parsed.username.split(".");
    if (userParts.length > 1) {
      usernamePrefix = userParts[1];
    }
  }

  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || "5432",
    databaseName,
    usernamePrefix,
  };
}

function validateTargetMatchesIdentifier(
  meta: ReturnType<typeof extractSafeMetadata>,
  approvedIdentifier: string,
  urlName: string
) {
  const matchesUserRef = meta.usernamePrefix === approvedIdentifier;
  const matchesSubdomain =
    meta.hostname === `db.${approvedIdentifier}.supabase.co` ||
    meta.hostname === `${approvedIdentifier}.supabase.co` ||
    meta.hostname.startsWith(`${approvedIdentifier}.`);
  const matchesDbName = meta.databaseName === approvedIdentifier;
  const matchesHost = meta.hostname === approvedIdentifier;

  const matchesApprovedIdentifier = matchesUserRef || matchesSubdomain || matchesDbName || matchesHost;

  if (!matchesApprovedIdentifier) {
    throw new DatabaseSafetyError(
      `${urlName} target (host: ${meta.hostname}, database: ${meta.databaseName}) does not match the approved SAAS_DATABASE_IDENTIFIER '${approvedIdentifier}'. Execution halted to protect production and unverified databases.`
    );
  }
}

/**
 * Resolves one safety input.
 *
 * The two modes are deliberately exclusive rather than layered:
 *
 *  - called with an explicit config (tests, tooling that knows the target), the
 *    config is the whole truth: a key that is absent or explicitly `undefined`
 *    resolves to `undefined`, so the guard fails closed instead of silently
 *    borrowing whatever the ambient process environment happens to hold;
 *  - called with no arguments (`lib/prisma.ts` and every maintenance script),
 *    the process environment is the source.
 *
 * The previous `config?.x ?? process.env.X` form mixed the two: an explicit
 * `undefined` fell through to `process.env`, so a caller that meant "this input
 * is missing, abort" could be satisfied by an unrelated ambient value. Which
 * branch a test took then depended on the developer's shell, on one platform
 * and not another.
 */
function resolveSafetyInput(
  config: DatabaseSafetyConfig | undefined,
  key: keyof DatabaseSafetyConfig,
  envName: string
): string | undefined {
  if (config === undefined) return process.env[envName];
  return config[key];
}

export function assertDatabaseSafety(config?: DatabaseSafetyConfig): DatabaseTargetMetadata {
  const env = resolveSafetyInput(config, "saasEnvironment", "SAAS_ENVIRONMENT");
  const identifier = resolveSafetyInput(config, "saasDatabaseIdentifier", "SAAS_DATABASE_IDENTIFIER");
  const dbUrl = resolveSafetyInput(config, "databaseUrl", "DATABASE_URL");
  const directUrl = resolveSafetyInput(config, "directUrl", "DIRECT_URL");

  // 1. Strict Environment Check
  if (!env || env.trim() === "") {
    throw new DatabaseSafetyError("SAAS_ENVIRONMENT environment variable is MISSING. Access aborted.");
  }

  if (env !== "saas") {
    throw new DatabaseSafetyError(
      `SAAS_ENVIRONMENT must be strictly 'saas', but received '${env}'. Access aborted.`
    );
  }

  // 2. Strict Identifier Check
  if (!identifier || identifier.trim() === "") {
    throw new DatabaseSafetyError("SAAS_DATABASE_IDENTIFIER environment variable is MISSING. Access aborted.");
  }

  const cleanIdentifier = identifier.trim();

  // 3. Database URL Check
  if (!dbUrl || dbUrl.trim() === "") {
    throw new DatabaseSafetyError("DATABASE_URL is missing or empty.");
  }

  const primaryMeta = extractSafeMetadata(dbUrl);

  // If DIRECT_URL is provided, it must also be validated
  if (directUrl && directUrl.trim() !== "") {
    const directMeta = extractSafeMetadata(directUrl);
    validateTargetMatchesIdentifier(directMeta, cleanIdentifier, "DIRECT_URL");
  }

  validateTargetMatchesIdentifier(primaryMeta, cleanIdentifier, "DATABASE_URL");

  return {
    protocol: primaryMeta.protocol,
    host: primaryMeta.hostname,
    port: primaryMeta.port,
    database: primaryMeta.databaseName,
    userPrefix: primaryMeta.usernamePrefix,
    identifierMatched: cleanIdentifier,
  };
}
