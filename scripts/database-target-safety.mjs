/**
 * Shared database target checks for standalone maintenance scripts.
 *
 * These checks bind a requested connection string to the explicitly configured
 * SaaS target; they do not replace human verification of the project and
 * migration history.
 *
 * This is the JavaScript twin of `lib/db-safety-guard.ts`, because the `.mjs`
 * maintenance scripts cannot import TypeScript. The rules are identical and
 * `__tests__/safety/database-identity.test.ts` runs the same matrix against both
 * implementations, so drift fails the suite rather than silently weakening a
 * guard.
 *
 * Identity model:
 *  - loopback target  -> the database name is the identity (local dev, rehearsals);
 *  - Supabase target  -> the 20-character project reference is the ONLY identity
 *    (from `db.<ref>.supabase.co` or the `<role>.<ref>` pooler username);
 *  - anything else remote -> refused.
 */

/** Supabase project references are 20 lowercase alphanumeric characters. */
export const SUPABASE_PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

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

export class DatabaseTargetSafetyError extends Error {
  constructor(message) {
    super(`[DATABASE TARGET SAFETY CHECK FAILED] ${message}`);
    this.name = "DatabaseTargetSafetyError";
  }
}

/** True for 127.0.0.0/8, localhost and the IPv6 loopback. */
export function isLoopbackHost(hostname) {
  const host = String(hostname).trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

function metadata(rawUrl, urlName) {
  let text = String(rawUrl).trim();
  text = text.replace(/^(DATABASE_URL|DIRECT_URL)\s*=\s*/i, "").trim();
  text = text.replace(/^["']+|["']+$/g, "").trim();

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new DatabaseTargetSafetyError(`${urlName} is not a valid PostgreSQL URL.`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new DatabaseTargetSafetyError(`${urlName} must use the postgres or postgresql protocol.`);
  }
  // libpq and other consumers can honor target overrides in URI query
  // parameters even when the URL authority appears safe. Never echo values.
  const targetOverrides = new Set(["host", "hostaddr", "port", "dbname", "service", "options"]);
  if ([...parsed.searchParams.keys()].some((key) => targetOverrides.has(key.toLowerCase()))) {
    throw new DatabaseTargetSafetyError("Database URL contains a forbidden connection target override.");
  }

  const database = parsed.pathname.replace(/^\//, "");
  if (!parsed.hostname || !database) {
    throw new DatabaseTargetSafetyError(`${urlName} must include a host and database name.`);
  }

  const usernameParts = parsed.username.split(".");
  return {
    protocol: parsed.protocol,
    host: parsed.hostname,
    port: parsed.port || "5432",
    database,
    userPrefix: usernameParts.length > 1 ? usernameParts[1] : undefined,
  };
}

/**
 * Classify a parsed target without connecting to anything.
 *
 * @param {{ host: string, userPrefix?: string }} target
 * @returns {{ kind: string, hostname: string, projectRef?: string }}
 */
export function classifyDatabaseTarget(target) {
  const hostname = String(target.host).trim().toLowerCase();

  if (isLoopbackHost(hostname)) {
    return { kind: "loopback", hostname };
  }

  const direct = hostname.match(/^db\.([a-z0-9]{20})\.supabase\.(?:co|in)$/);
  if (direct) {
    return { kind: "supabase-direct", hostname, projectRef: direct[1] };
  }

  if (/^(?:[a-z0-9-]+\.)*pooler\.supabase\.com$/.test(hostname)) {
    const ref = target.userPrefix ? String(target.userPrefix).trim().toLowerCase() : undefined;
    const isRefShaped = ref !== undefined && SUPABASE_PROJECT_REF_PATTERN.test(ref);
    return { kind: "supabase-pooler", hostname, projectRef: isRefShaped ? ref : undefined };
  }

  return { kind: "unknown-remote", hostname };
}

function mismatch(target, urlName, identifier, reason) {
  return new DatabaseTargetSafetyError(
    `${urlName} target (host: ${target.host}, database: ${target.database}) does not match the approved ` +
      `SAAS_DATABASE_IDENTIFIER '${identifier}': ${reason}. Execution halted to protect production and ` +
      "unverified databases."
  );
}

function bindIdentity(target, identifier, urlName) {
  const identity = classifyDatabaseTarget(target);

  if (identity.kind === "loopback") {
    if (target.database !== identifier) {
      throw mismatch(
        target,
        urlName,
        identifier,
        `this is a loopback target and its database name is '${target.database}'`
      );
    }
    return identity;
  }

  if (identity.kind === "unknown-remote") {
    throw mismatch(
      target,
      urlName,
      identifier,
      `it is not a recognisable Supabase endpoint (only loopback databases and db.<ref>.supabase.co or ` +
        `*.pooler.supabase.com endpoints are accepted)`
    );
  }

  if (!SUPABASE_PROJECT_REF_PATTERN.test(identifier)) {
    throw mismatch(
      target,
      urlName,
      identifier,
      `remote targets require the 20-character Supabase project reference, and '${identifier}' is not one`
    );
  }

  if (!identity.projectRef) {
    throw mismatch(
      target,
      urlName,
      identifier,
      "the Supabase project reference could not be derived from the connection string"
    );
  }

  if (identity.projectRef !== identifier) {
    throw mismatch(
      target,
      urlName,
      identifier,
      `the endpoint belongs to Supabase project '${identity.projectRef}'`
    );
  }

  if (identifier !== "jhablmqphfcjwealyxxr") {
    throw new DatabaseTargetSafetyError("Remote databases are restricted to the approved SaaS Supabase project jhablmqphfcjwealyxxr.");
  }

  return identity;
}

/**
 * Bind every supplied connection string to the approved identifier.
 *
 * @param {object} input
 * @param {string} input.environment       must be exactly "saas"
 * @param {string} input.identifier        Supabase project reference (or a loopback database name)
 * @param {string} input.databaseUrl       pooled/target URL
 * @param {string} [input.directUrl]       direct URL, validated whenever present
 * @param {boolean|"remote"} [input.requireDirectUrl]  require DIRECT_URL (always, or only for a remote target)
 */
export function assertDatabaseTarget({
  environment,
  identifier,
  databaseUrl,
  directUrl = undefined,
  requireDirectUrl = false,
}) {
  if (environment !== "saas") {
    throw new DatabaseTargetSafetyError("SAAS_ENVIRONMENT must be explicitly set to 'saas'.");
  }
  if (!identifier || !String(identifier).trim()) {
    throw new DatabaseTargetSafetyError("SAAS_DATABASE_IDENTIFIER must be explicitly set.");
  }

  const approvedIdentifier = String(identifier).trim();

  if (RESERVED_IDENTIFIERS.has(approvedIdentifier.toLowerCase())) {
    throw new DatabaseTargetSafetyError(
      `SAAS_DATABASE_IDENTIFIER must be the Supabase project reference, but received the reserved value ` +
        `'${approvedIdentifier}'. A database or role name identifies every project, not one.`
    );
  }

  if (approvedIdentifier !== approvedIdentifier.toLowerCase()) {
    throw new DatabaseTargetSafetyError(
      `SAAS_DATABASE_IDENTIFIER must be lowercase, but received '${approvedIdentifier}'.`
    );
  }

  if (!databaseUrl || !String(databaseUrl).trim()) {
    throw new DatabaseTargetSafetyError("A database connection string is required.");
  }

  const primary = metadata(databaseUrl, "Database target");
  const primaryIdentity = classifyDatabaseTarget(primary);

  const hasDirect = Boolean(directUrl && String(directUrl).trim());
  const directRequired =
    requireDirectUrl === true || (requireDirectUrl === "remote" && primaryIdentity.kind !== "loopback");

  if (!hasDirect && directRequired) {
    throw new DatabaseTargetSafetyError(
      "DIRECT_URL is missing or empty, but this operation needs a direct connection. Access aborted."
    );
  }

  let direct = null;
  let directIdentity = null;
  if (hasDirect) {
    direct = metadata(directUrl, "DIRECT_URL");
    directIdentity = bindIdentity(direct, approvedIdentifier, "DIRECT_URL");
  }

  const identity = bindIdentity(primary, approvedIdentifier, "Database target");

  if (directIdentity) {
    const primaryIsLoopback = identity.kind === "loopback";
    const directIsLoopback = directIdentity.kind === "loopback";

    if (primaryIsLoopback !== directIsLoopback) {
      throw new DatabaseTargetSafetyError(
        "DATABASE_URL and DIRECT_URL point at different targets: one is a loopback database and the other is " +
          "remote. Both must describe the same database."
      );
    }

    if (!primaryIsLoopback && identity.projectRef !== directIdentity.projectRef) {
      throw new DatabaseTargetSafetyError(
        `DATABASE_URL and DIRECT_URL belong to different Supabase projects ('${identity.projectRef}' and ` +
          `'${directIdentity.projectRef}'). Both must describe the same database.`
      );
    }
  }

  return {
    host: primary.host,
    port: primary.port,
    database: primary.database,
    userPrefix: primary.userPrefix,
    kind: identity.kind,
    projectRef: identity.projectRef,
    directKind: directIdentity ? directIdentity.kind : undefined,
    identifierMatched: approvedIdentifier,
  };
}
