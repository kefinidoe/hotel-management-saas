/**
 * Fail-Closed Database Safety Guard for Hotel Management SaaS.
 *
 * Ensures that under NO circumstance can the application, Prisma client,
 * migration scripts, or maintenance tools connect to an unverified database
 * or the legacy single-tenant production database.
 *
 * Identity model (round 28)
 * -------------------------
 * The guard recognises exactly two kinds of target:
 *
 *  1. A **loopback** database (127.0.0.1 / localhost / ::1). Identity is the
 *     database name, which is how local development, the owner-test harness and
 *     the restore rehearsals have always been configured. A loopback target
 *     cannot be the Axis Hotel database or any shared server.
 *
 *  2. A **Supabase** endpoint. Identity is the *project reference* only — the
 *     20-character ref that Supabase embeds in the direct hostname
 *     (`db.<ref>.supabase.co`) and in the pooler username (`<role>.<ref>`).
 *     Database-name matching is NOT accepted for a remote target: every Supabase
 *     project has a database called `postgres`, so matching on the database name
 *     would accept any Supabase project, including the legacy one.
 *
 * Anything else that is not loopback is refused outright.
 */

export class DatabaseSafetyError extends Error {
  constructor(message: string) {
    super(`[CRITICAL DATABASE SAFETY VIOLATION] ${message}`);
    this.name = "DatabaseSafetyError";
  }
}

/** Supabase project references are 20 lowercase alphanumeric characters. */
export const SUPABASE_PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

/**
 * Identifiers that name a *role* or a stock database rather than a project.
 * `postgres` is the important one: it is both the default role and the default
 * database name in every Supabase project, so accepting it as the identity would
 * make the guard pass for any project.
 */
const RESERVED_IDENTIFIERS = new Set([
  "postgres",
  "postgresql",
  "public",
  "template0",
  "template1",
  "db",
  "admin",
  "root",
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type DatabaseTargetKind = "loopback" | "supabase-direct" | "supabase-pooler" | "unknown-remote";

export interface DatabaseTargetIdentity {
  kind: DatabaseTargetKind;
  hostname: string;
  /** Present only for a Supabase endpoint whose reference could be derived. */
  projectRef?: string;
}

export interface DatabaseTargetMetadata {
  protocol: string;
  host: string;
  port: string;
  database: string;
  userPrefix?: string;
  identifierMatched: string;
  /** Which endpoint class DATABASE_URL resolved to. */
  kind: DatabaseTargetKind;
  /** Present when DATABASE_URL resolved to a Supabase project. */
  projectRef?: string;
  /** Which endpoint class DIRECT_URL resolved to, when it was supplied. */
  directKind?: DatabaseTargetKind;
}

export interface DatabaseSafetyConfig {
  saasEnvironment?: string;
  saasDatabaseIdentifier?: string;
  databaseUrl?: string;
  directUrl?: string;
}

export interface DatabaseSafetyOptions {
  /**
   * Require DIRECT_URL to be present.
   *
   * - `true`      — always required (migration commands: Prisma uses DIRECT_URL
   *                 for every DDL statement).
   * - `"remote"`  — required only when DATABASE_URL is not loopback (the verifier
   *                 and `db:verify` use this so local development does not need a
   *                 second URL).
   * - `false` / omitted — optional, but validated whenever present.
   */
  requireDirectUrl?: boolean | "remote";
}

/** Runtime availability check for offline-preview and API error handling. */
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  // The whole 127.0.0.0/8 block is loopback.
  return /^127(?:\.\d{1,3}){3}$/.test(host);
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

  // libpq and other consumers can honor target overrides in URI query
  // parameters even when the URL authority appears safe. Never echo values.
  const targetOverrides = new Set(["host", "hostaddr", "port", "dbname", "service", "options"]);
  if ([...parsed.searchParams.keys()].some((key) => targetOverrides.has(key.toLowerCase()))) {
    throw new DatabaseSafetyError("Database URL contains a forbidden connection target override.");
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

/**
 * Classify a connection string without connecting to anything.
 *
 * The project reference is taken from the two places Supabase actually puts it:
 * the direct hostname (`db.<ref>.supabase.co` / `.supabase.in`) and the pooler
 * username (`<role>.<ref>` on `*.pooler.supabase.com`). No other part of the URL
 * is trusted as identity.
 */
export function classifyDatabaseTarget(meta: ReturnType<typeof extractSafeMetadata>): DatabaseTargetIdentity {
  const hostname = meta.hostname.trim().toLowerCase();

  if (isLoopbackHost(hostname)) {
    return { kind: "loopback", hostname };
  }

  const direct = hostname.match(/^db\.([a-z0-9]{20})\.supabase\.(?:co|in)$/);
  if (direct) {
    return { kind: "supabase-direct", hostname, projectRef: direct[1] };
  }

  if (/^(?:[a-z0-9-]+\.)*pooler\.supabase\.com$/.test(hostname)) {
    const ref = meta.usernamePrefix?.trim().toLowerCase();
    const isRefShaped = ref !== undefined && SUPABASE_PROJECT_REF_PATTERN.test(ref);
    return {
      kind: "supabase-pooler",
      hostname,
      projectRef: isRefShaped ? ref : undefined,
    };
  }

  // A host that merely contains "supabase" in a longer name, or any other
  // remote host, is not a verified Supabase endpoint.
  return { kind: "unknown-remote", hostname };
}

function mismatch(
  urlName: string,
  meta: ReturnType<typeof extractSafeMetadata>,
  identifier: string,
  reason: string
): DatabaseSafetyError {
  return new DatabaseSafetyError(
    `${urlName} target (host: ${meta.hostname}, database: ${meta.databaseName}) does not match the approved ` +
      `SAAS_DATABASE_IDENTIFIER '${identifier}': ${reason}. Execution halted to protect production and ` +
      "unverified databases."
  );
}

/**
 * Bind one connection string to the approved identifier.
 *
 * Loopback targets are bound by database name (local development keeps working);
 * remote targets are bound strictly by Supabase project reference. There is no
 * rule under which a remote target is accepted because its hostname or database
 * name happens to equal the identifier.
 */
function validateTargetMatchesIdentifier(
  meta: ReturnType<typeof extractSafeMetadata>,
  approvedIdentifier: string,
  urlName: string
): DatabaseTargetIdentity {
  const identity = classifyDatabaseTarget(meta);

  if (identity.kind === "loopback") {
    if (meta.databaseName !== approvedIdentifier) {
      throw mismatch(
        urlName,
        meta,
        approvedIdentifier,
        `this is a loopback target and its database name is '${meta.databaseName}'`
      );
    }
    return identity;
  }

  if (identity.kind === "unknown-remote") {
    throw mismatch(
      urlName,
      meta,
      approvedIdentifier,
      `it is not a recognisable Supabase endpoint (only loopback databases and db.<ref>.supabase.co or ` +
        `*.pooler.supabase.com endpoints are accepted)`
    );
  }

  if (!SUPABASE_PROJECT_REF_PATTERN.test(approvedIdentifier)) {
    throw mismatch(
      urlName,
      meta,
      approvedIdentifier,
      `remote targets require the 20-character Supabase project reference, and '${approvedIdentifier}' is not one`
    );
  }

  if (!identity.projectRef) {
    throw mismatch(
      urlName,
      meta,
      approvedIdentifier,
      "the Supabase project reference could not be derived from the connection string"
    );
  }

  if (identity.projectRef !== approvedIdentifier) {
    throw mismatch(
      urlName,
      meta,
      approvedIdentifier,
      `the endpoint belongs to Supabase project '${identity.projectRef}'`
    );
  }

  if (approvedIdentifier !== "jhablmqphfcjwealyxxr") {
    throw new DatabaseSafetyError("Remote databases are restricted to the approved SaaS Supabase project jhablmqphfcjwealyxxr.");
  }

  return identity;
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

export function assertDatabaseSafety(
  config?: DatabaseSafetyConfig,
  options: DatabaseSafetyOptions = {}
): DatabaseTargetMetadata {
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

  if (RESERVED_IDENTIFIERS.has(cleanIdentifier.toLowerCase())) {
    throw new DatabaseSafetyError(
      `SAAS_DATABASE_IDENTIFIER must be the Supabase project reference, but received the reserved value ` +
        `'${cleanIdentifier}'. A database or role name identifies every project, not one. Access aborted.`
    );
  }

  if (cleanIdentifier !== cleanIdentifier.toLowerCase()) {
    throw new DatabaseSafetyError(
      `SAAS_DATABASE_IDENTIFIER must be lowercase, but received '${cleanIdentifier}'. Access aborted.`
    );
  }

  // 3. Database URL Check
  if (!dbUrl || dbUrl.trim() === "") {
    throw new DatabaseSafetyError("DATABASE_URL is missing or empty.");
  }

  const primaryMeta = extractSafeMetadata(dbUrl);
  const primaryIdentity = classifyDatabaseTarget(primaryMeta);

  // 4. DIRECT_URL requirement
  const directRequired =
    options.requireDirectUrl === true ||
    (options.requireDirectUrl === "remote" && primaryIdentity.kind !== "loopback");

  const hasDirect = Boolean(directUrl && directUrl.trim() !== "");

  if (!hasDirect && directRequired) {
    throw new DatabaseSafetyError(
      "DIRECT_URL is missing or empty, but this operation needs a direct connection " +
        "(Prisma runs every migration statement over DIRECT_URL). Access aborted."
    );
  }

  // 5. DIRECT_URL identity (validated first, matching the original ordering that
  //    callers and tests rely on: a bad DIRECT_URL must be reported even when the
  //    pooled URL is also wrong).
  let directMeta: ReturnType<typeof extractSafeMetadata> | undefined;
  let directIdentity: DatabaseTargetIdentity | undefined;

  if (hasDirect) {
    directMeta = extractSafeMetadata(directUrl as string);
    directIdentity = validateTargetMatchesIdentifier(directMeta, cleanIdentifier, "DIRECT_URL");
  }

  // 6. DATABASE_URL identity
  const identity = validateTargetMatchesIdentifier(primaryMeta, cleanIdentifier, "DATABASE_URL");

  // 7. Pooled and direct URLs must belong to the same place.
  if (directIdentity) {
    const primaryIsLoopback = identity.kind === "loopback";
    const directIsLoopback = directIdentity.kind === "loopback";

    if (primaryIsLoopback !== directIsLoopback) {
      throw new DatabaseSafetyError(
        "DATABASE_URL and DIRECT_URL point at different targets: one is a loopback database and the other is " +
          "remote. Both must describe the same database. Access aborted."
      );
    }

    if (!primaryIsLoopback && identity.projectRef !== directIdentity.projectRef) {
      throw new DatabaseSafetyError(
        `DATABASE_URL and DIRECT_URL belong to different Supabase projects ('${identity.projectRef}' and ` +
          `'${directIdentity.projectRef}'). Both must describe the same database. Access aborted.`
      );
    }
  }

  return {
    protocol: primaryMeta.protocol,
    host: primaryMeta.hostname,
    port: primaryMeta.port,
    database: primaryMeta.databaseName,
    userPrefix: primaryMeta.usernamePrefix,
    identifierMatched: cleanIdentifier,
    kind: identity.kind,
    projectRef: identity.projectRef,
    directKind: directIdentity?.kind,
  };
}
