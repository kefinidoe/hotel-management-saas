type SeedEnvironment = {
  [key: string]: string | undefined;
  SAAS_ENVIRONMENT?: string;
  SAAS_ALLOW_LOCAL_DEMO_SEED?: string;
  DATABASE_URL?: string;
  DIRECT_URL?: string;
};

type LocalTarget = {
  host: string;
  port: string;
  database: string;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DEMO_DATABASE_PATTERN = /^hotel_saas_demo_[a-z0-9][a-z0-9_-]*$/i;

function parseLocalTarget(rawUrl: string | undefined, variableName: string): LocalTarget {
  if (!rawUrl) {
    throw new Error(`${variableName} must be set to the dedicated local demo database.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL.`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${variableName} must use the PostgreSQL protocol.`);
  }
  const targetOverrideParameters = new Set(["host", "hostaddr", "service", "port", "dbname"]);
  if ([...parsed.searchParams.keys()].some((name) => targetOverrideParameters.has(name.toLowerCase()))) {
    throw new Error(`${variableName} cannot override the loopback connection target in URL parameters.`);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch {
    throw new Error(`${variableName} must contain a valid database name.`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`${variableName} must point to a loopback host; remote seed targets are refused.`);
  }
  if (!DEMO_DATABASE_PATTERN.test(database)) {
    throw new Error(`${variableName} must target a database named hotel_saas_demo_<suffix>.`);
  }

  return { host, port: parsed.port || "5432", database };
}

/** Prevent the fictional demo seeder from writing to SaaS or any remote database. */
export function assertLocalDemoSeedTarget(environment: SeedEnvironment = process.env): void {
  if (environment.SAAS_ENVIRONMENT !== "local") {
    throw new Error("Demo seeding requires SAAS_ENVIRONMENT=local.");
  }
  if (environment.SAAS_ALLOW_LOCAL_DEMO_SEED !== "true") {
    throw new Error("Demo seeding requires the explicit SAAS_ALLOW_LOCAL_DEMO_SEED=true opt-in.");
  }

  const primary = parseLocalTarget(environment.DATABASE_URL, "DATABASE_URL");
  const direct = parseLocalTarget(environment.DIRECT_URL, "DIRECT_URL");
  if (
    primary.host !== direct.host ||
    primary.port !== direct.port ||
    primary.database !== direct.database
  ) {
    throw new Error("DATABASE_URL and DIRECT_URL must target the same local demo database.");
  }
}
