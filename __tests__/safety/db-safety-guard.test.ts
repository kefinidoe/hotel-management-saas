import { describe, it, expect } from "vitest";
import {
  assertDatabaseSafety,
  extractSafeMetadata,
  DatabaseSafetyError,
} from "../../lib/db-safety-guard";

function withProcessEnvironment(
  values: Record<string, string | undefined>,
  run: () => void
) {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  try {
    run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("Database Safety Guard — Process Environment", () => {
  it("fails closed when SAAS_ENVIRONMENT is missing from process.env", () => {
    withProcessEnvironment({
      SAAS_ENVIRONMENT: undefined,
      SAAS_DATABASE_IDENTIFIER: "hotel_saas_local",
      DATABASE_URL: "postgresql://local@127.0.0.1:5432/hotel_saas_local",
      DIRECT_URL: undefined,
    }, () => {
      expect(() => assertDatabaseSafety()).toThrow(/SAAS_ENVIRONMENT environment variable is MISSING/);
    });
  });

  it("fails closed for an invalid SAAS_ENVIRONMENT from process.env", () => {
    withProcessEnvironment({
      SAAS_ENVIRONMENT: "development",
      SAAS_DATABASE_IDENTIFIER: "hotel_saas_local",
      DATABASE_URL: "postgresql://local@127.0.0.1:5432/hotel_saas_local",
      DIRECT_URL: undefined,
    }, () => {
      expect(() => assertDatabaseSafety()).toThrow(/SAAS_ENVIRONMENT must be strictly 'saas'/);
    });
  });
});

describe("Database Safety Guard — Fail-Closed Behavior", () => {
  it("fails closed when SAAS_ENVIRONMENT is missing", () => {
    expect(() =>
      assertDatabaseSafety({
        saasEnvironment: undefined,
        saasDatabaseIdentifier: "saas-hotel-db",
        databaseUrl: "postgresql://postgres.saas-hotel-db:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
      })
    ).toThrow(DatabaseSafetyError);

    expect(() =>
      assertDatabaseSafety({
        saasEnvironment: "",
        saasDatabaseIdentifier: "saas-hotel-db",
        databaseUrl: "postgresql://postgres.saas-hotel-db:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
      })
    ).toThrow(/SAAS_ENVIRONMENT environment variable is MISSING/);
  });

  it("fails closed when SAAS_ENVIRONMENT is anything other than 'saas' (e.g. 'production', 'prod')", () => {
    for (const invalidEnv of ["production", "prod", "staging", "dev", "test"]) {
      expect(() =>
        assertDatabaseSafety({
          saasEnvironment: invalidEnv,
          saasDatabaseIdentifier: "saas-hotel-db",
          databaseUrl: "postgresql://postgres.saas-hotel-db:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
        })
      ).toThrow(/SAAS_ENVIRONMENT must be strictly 'saas'/);
    }
  });

  it("fails closed when SAAS_DATABASE_IDENTIFIER is missing or empty", () => {
    expect(() =>
      assertDatabaseSafety({
        saasEnvironment: "saas",
        saasDatabaseIdentifier: undefined,
        databaseUrl: "postgresql://postgres.saas-hotel-db:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
      })
    ).toThrow(/SAAS_DATABASE_IDENTIFIER environment variable is MISSING/);

    expect(() =>
      assertDatabaseSafety({
        saasEnvironment: "saas",
        saasDatabaseIdentifier: "   ",
        databaseUrl: "postgresql://postgres.saas-hotel-db:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
      })
    ).toThrow(/SAAS_DATABASE_IDENTIFIER environment variable is MISSING/);
  });

  it("fails closed when DATABASE_URL is missing or empty", () => {
    expect(() =>
      assertDatabaseSafety({
        saasEnvironment: "saas",
        saasDatabaseIdentifier: "saas-hotel-db",
        databaseUrl: "",
      })
    ).toThrow(/DATABASE_URL is missing or empty/);
  });

  it("fails closed when target database does NOT match the approved SaaS identifier", () => {
    // Attempting to connect to another project or production reference
    expect(() =>
      assertDatabaseSafety({
        saasEnvironment: "saas",
        saasDatabaseIdentifier: "saas-new-cluster-99",
        databaseUrl: "postgresql://postgres.unapproved-prod-ref:s3cret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
      })
    ).toThrow(/does not match the approved SAAS_DATABASE_IDENTIFIER/);
  });

  it("fails closed when DIRECT_URL does not match the approved SaaS identifier", () => {
    expect(() =>
      assertDatabaseSafety({
        saasEnvironment: "saas",
        saasDatabaseIdentifier: "saas-new-cluster-99",
        databaseUrl: "postgresql://postgres.saas-new-cluster-99:s3cret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
        directUrl: "postgresql://postgres.unapproved-direct-ref:s3cret@db.unapproved-direct-ref.supabase.co:5432/postgres",
      })
    ).toThrow(/DIRECT_URL target .* does not match the approved SAAS_DATABASE_IDENTIFIER/);
  });

  it("never includes database passwords in error messages", () => {
    const rawPassword = "super-secret-password-xyz123";
    try {
      assertDatabaseSafety({
        saasEnvironment: "saas",
        saasDatabaseIdentifier: "approved-saas-db",
        databaseUrl: `postgresql://postgres.unapproved-db:${rawPassword}@db.unapproved-db.supabase.co:5432/postgres`,
      });
      throw new Error("Should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(rawPassword);
      expect((err as Error).message).toContain("does not match the approved SAAS_DATABASE_IDENTIFIER");
    }
  });
});

describe("Database Safety Guard — Explicit Config Is Hermetic", () => {
  /**
   * Regression: the guard used to resolve each input as
   * `config?.x ?? process.env.X`. An explicit `undefined` is not "no opinion", it
   * is "this input is absent", so falling through to `process.env` let an ambient
   * variable satisfy a check the caller had deliberately left empty — making the
   * fail-closed tests above pass or fail depending on the developer's shell.
   */
  const populated = {
    SAAS_ENVIRONMENT: "saas",
    SAAS_DATABASE_IDENTIFIER: "saas-hotel-db",
    DATABASE_URL: "postgresql://postgres.saas-hotel-db:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
    DIRECT_URL: "postgresql://postgres:secret@db.saas-hotel-db.supabase.co:5432/postgres",
  };

  it("does not borrow a populated process.env for an explicit undefined", () => {
    withProcessEnvironment(populated, () => {
      expect(() =>
        assertDatabaseSafety({
          saasEnvironment: undefined,
          saasDatabaseIdentifier: "saas-hotel-db",
          databaseUrl: populated.DATABASE_URL,
        })
      ).toThrow(/SAAS_ENVIRONMENT environment variable is MISSING/);

      expect(() =>
        assertDatabaseSafety({
          saasEnvironment: "saas",
          saasDatabaseIdentifier: undefined,
          databaseUrl: populated.DATABASE_URL,
        })
      ).toThrow(/SAAS_DATABASE_IDENTIFIER environment variable is MISSING/);

      expect(() =>
        assertDatabaseSafety({
          saasEnvironment: "saas",
          saasDatabaseIdentifier: "saas-hotel-db",
          databaseUrl: undefined,
        })
      ).toThrow(/DATABASE_URL is missing or empty/);
    });
  });

  it("does not borrow process.env for keys the config object omits", () => {
    withProcessEnvironment(populated, () => {
      expect(() =>
        assertDatabaseSafety({
          saasDatabaseIdentifier: "saas-hotel-db",
          databaseUrl: populated.DATABASE_URL,
        })
      ).toThrow(/SAAS_ENVIRONMENT environment variable is MISSING/);
    });
  });

  it("still reads process.env when called with no config at all", () => {
    withProcessEnvironment(populated, () => {
      const result = assertDatabaseSafety();
      expect(result.identifierMatched).toBe("saas-hotel-db");
      expect(result.database).toBe("postgres");
    });
  });

  it("rejects a config whose explicit undefined hides a URL that env would have validated", () => {
    withProcessEnvironment(populated, () => {
      // DATABASE_URL is deliberately undefined: the DIRECT_URL in env must not be
      // promoted into its place, and DIRECT_URL itself must not be read either.
      expect(() =>
        assertDatabaseSafety({
          saasEnvironment: "saas",
          saasDatabaseIdentifier: "saas-hotel-db",
          databaseUrl: undefined,
          directUrl: undefined,
        })
      ).toThrow(/DATABASE_URL is missing or empty/);
    });
  });
});

describe("Database Safety Guard — Approved Target Acceptance", () => {
  it("accepts Supabase transaction pooler URL matching approved identifier in user prefix", () => {
    const result = assertDatabaseSafety({
      saasEnvironment: "saas",
      saasDatabaseIdentifier: "hotel-saas-dev-1234",
      databaseUrl: "postgresql://postgres.hotel-saas-dev-1234:pw123@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
    });

    expect(result.identifierMatched).toBe("hotel-saas-dev-1234");
    expect(result.host).toBe("aws-0-eu-west-1.pooler.supabase.com");
    expect(result.port).toBe("6543");
    expect(result.database).toBe("postgres");
    expect(result.userPrefix).toBe("hotel-saas-dev-1234");
  });

  it("accepts Supabase direct URL matching approved identifier in host subdomain", () => {
    const result = assertDatabaseSafety({
      saasEnvironment: "saas",
      saasDatabaseIdentifier: "hotel-saas-dev-1234",
      databaseUrl: "postgresql://postgres:pw123@db.hotel-saas-dev-1234.supabase.co:5432/postgres",
    });

    expect(result.identifierMatched).toBe("hotel-saas-dev-1234");
    expect(result.host).toBe("db.hotel-saas-dev-1234.supabase.co");
    expect(result.port).toBe("5432");
    expect(result.database).toBe("postgres");
  });

  it("accepts local development database matching approved identifier in db name", () => {
    const result = assertDatabaseSafety({
      saasEnvironment: "saas",
      saasDatabaseIdentifier: "hotel_saas_dev",
      databaseUrl: "postgresql://postgres:pw123@localhost:5432/hotel_saas_dev",
    });

    expect(result.identifierMatched).toBe("hotel_saas_dev");
    expect(result.host).toBe("localhost");
    expect(result.port).toBe("5432");
    expect(result.database).toBe("hotel_saas_dev");
  });

  it("accepts both DATABASE_URL and DIRECT_URL when both match approved identifier", () => {
    const result = assertDatabaseSafety({
      saasEnvironment: "saas",
      saasDatabaseIdentifier: "hotel-saas-dev-1234",
      databaseUrl: "postgresql://postgres.hotel-saas-dev-1234:pw123@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
      directUrl: "postgresql://postgres:pw123@db.hotel-saas-dev-1234.supabase.co:5432/postgres",
    });

    expect(result.identifierMatched).toBe("hotel-saas-dev-1234");
  });
});
