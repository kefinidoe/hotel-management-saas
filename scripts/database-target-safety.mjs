/**
 * Shared database target checks for standalone maintenance scripts. These checks
 * bind a requested connection string to the explicitly configured SaaS target;
 * they do not replace human verification of the project and migration history.
 */
export class DatabaseTargetSafetyError extends Error {
  constructor(message) {
    super(`[DATABASE TARGET SAFETY CHECK FAILED] ${message}`);
    this.name = "DatabaseTargetSafetyError";
  }
}

function metadata(rawUrl, urlName) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl).trim().replace(/^["']+|["']+$/g, ""));
  } catch {
    throw new DatabaseTargetSafetyError(`${urlName} is not a valid PostgreSQL URL.`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new DatabaseTargetSafetyError(`${urlName} must use the postgres or postgresql protocol.`);
  }
  const database = parsed.pathname.replace(/^\//, "");
  if (!parsed.hostname || !database) {
    throw new DatabaseTargetSafetyError(`${urlName} must include a host and database name.`);
  }

  const usernameParts = parsed.username.split(".");
  return {
    host: parsed.hostname,
    database,
    userPrefix: usernameParts.length > 1 ? usernameParts[1] : undefined,
  };
}

function matchesIdentifier(target, identifier) {
  return (
    target.userPrefix === identifier ||
    target.host === `db.${identifier}.supabase.co` ||
    target.host === `${identifier}.supabase.co` ||
    target.host.startsWith(`${identifier}.`) ||
    target.database === identifier ||
    target.host === identifier
  );
}

export function assertDatabaseTarget({ environment, identifier, databaseUrl, directUrl = undefined }) {
  if (environment !== "saas") {
    throw new DatabaseTargetSafetyError("SAAS_ENVIRONMENT must be explicitly set to 'saas'.");
  }
  if (!identifier || !String(identifier).trim()) {
    throw new DatabaseTargetSafetyError("SAAS_DATABASE_IDENTIFIER must be explicitly set.");
  }
  const approvedIdentifier = String(identifier).trim();
  if (!databaseUrl || !String(databaseUrl).trim()) {
    throw new DatabaseTargetSafetyError("A database connection string is required.");
  }

  const primary = metadata(databaseUrl, "Database target");
  if (!matchesIdentifier(primary, approvedIdentifier)) {
    throw new DatabaseTargetSafetyError(
      `Database target (host: ${primary.host}, database: ${primary.database}) does not match SAAS_DATABASE_IDENTIFIER '${approvedIdentifier}'.`
    );
  }

  if (directUrl && String(directUrl).trim()) {
    const direct = metadata(directUrl, "DIRECT_URL");
    if (!matchesIdentifier(direct, approvedIdentifier)) {
      throw new DatabaseTargetSafetyError(
        `DIRECT_URL target (host: ${direct.host}, database: ${direct.database}) does not match SAAS_DATABASE_IDENTIFIER '${approvedIdentifier}'.`
      );
    }
  }

  return { ...primary, identifierMatched: approvedIdentifier };
}
