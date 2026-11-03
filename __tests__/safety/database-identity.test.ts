import { describe, expect, it } from "vitest";

import { assertDatabaseSafety, DatabaseSafetyError } from "../../lib/db-safety-guard";
import { assertDatabaseTarget } from "../../scripts/database-target-safety.mjs";

/**
 * One matrix, two implementations.
 *
 * `lib/db-safety-guard.ts` is what the application and `db:verify` use;
 * `scripts/database-target-safety.mjs` is what every `.mjs` maintenance script
 * and the Prisma wrapper use. They are separate files only because TypeScript
 * cannot be imported from a plain `node script.mjs` run. Running the same cases
 * through both is what stops them from drifting apart.
 */

const REF = "jhablmqphfcjwealyxxr";
const OTHER_REF = "otherprojectref12345";

const POOLED = `postgresql://postgres.${REF}:sup3r-s3cret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true`;
const DIRECT = `postgresql://postgres:sup3r-s3cret@db.${REF}.supabase.co:5432/postgres`;
const POOLED_OTHER = `postgresql://postgres.${OTHER_REF}:sup3r-s3cret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`;
const DIRECT_OTHER = `postgresql://postgres:sup3r-s3cret@db.${OTHER_REF}.supabase.co:5432/postgres`;
const LOCAL = "postgresql://postgres:pw@127.0.0.1:5432/hotel_saas_dev";

interface Case {
  name: string;
  identifier: string;
  databaseUrl: string;
  directUrl?: string;
  requireDirect?: boolean | "remote";
  accepted?: boolean;
  /** Matched against the TypeScript guard's message. */
  tsError?: RegExp;
  /** Matched against the `.mjs` guard's message. */
  mjsError?: RegExp;
}

const cases: Case[] = [
  {
    name: "accepts the approved project reference for pooled and direct URLs",
    identifier: REF,
    databaseUrl: POOLED,
    directUrl: DIRECT,
    accepted: true,
  },
  {
    name: "accepts the approved reference with no DIRECT_URL when it is not required",
    identifier: REF,
    databaseUrl: POOLED,
    accepted: true,
  },
  {
    name: "accepts a legacy .supabase.in direct hostname",
    identifier: REF,
    databaseUrl: `postgresql://postgres:pw@db.${REF}.supabase.in:5432/postgres`,
    accepted: true,
  },
  {
    name: "accepts a loopback database whose name is the identifier",
    identifier: "hotel_saas_dev",
    databaseUrl: LOCAL,
    accepted: true,
  },
  {
    name: "rejects a different project reference",
    identifier: REF,
    databaseUrl: POOLED_OTHER,
    tsError: /does not match the approved SAAS_DATABASE_IDENTIFIER/,
    mjsError: /does not match the approved SAAS_DATABASE_IDENTIFIER/,
  },
  {
    name: "rejects the reserved identifier 'postgres'",
    identifier: "postgres",
    databaseUrl: POOLED,
    tsError: /must be the Supabase project reference/,
    mjsError: /must be the Supabase project reference/,
  },
  {
    name: "rejects the identifier 'POSTGRES' regardless of case",
    identifier: "POSTGRES",
    databaseUrl: POOLED,
    tsError: /lowercase|must be the Supabase project reference/,
    mjsError: /lowercase|must be the Supabase project reference/,
  },
  {
    name: "rejects an uppercase project reference",
    identifier: REF.toUpperCase(),
    databaseUrl: POOLED,
    tsError: /lowercase/,
    mjsError: /lowercase/,
  },
  {
    name: "rejects a missing DATABASE_URL",
    identifier: REF,
    databaseUrl: "",
    tsError: /DATABASE_URL is missing or empty/,
    mjsError: /connection string is required/,
  },
  {
    name: "rejects a missing DIRECT_URL when the operation requires it",
    identifier: REF,
    databaseUrl: POOLED,
    requireDirect: true,
    tsError: /DIRECT_URL is missing or empty/,
    mjsError: /DIRECT_URL is missing or empty/,
  },
  {
    name: "rejects a missing DIRECT_URL for a remote target when requireDirect is 'remote'",
    identifier: REF,
    databaseUrl: POOLED,
    requireDirect: "remote",
    tsError: /DIRECT_URL is missing or empty/,
    mjsError: /DIRECT_URL is missing or empty/,
  },
  {
    name: "accepts a missing DIRECT_URL for a loopback target when requireDirect is 'remote'",
    identifier: "hotel_saas_dev",
    databaseUrl: LOCAL,
    requireDirect: "remote",
    accepted: true,
  },
  {
    name: "rejects pooled and direct URLs that belong to different projects",
    identifier: REF,
    databaseUrl: POOLED,
    directUrl: DIRECT_OTHER,
    tsError: /DIRECT_URL target .* does not match the approved SAAS_DATABASE_IDENTIFIER/,
    mjsError: /DIRECT_URL target .* does not match the approved SAAS_DATABASE_IDENTIFIER/,
  },
  {
    name: "rejects a Supabase look-alike hostname",
    identifier: REF,
    databaseUrl: `postgresql://postgres:pw@db.${REF}.supabase.co.evil.example:5432/postgres`,
    tsError: /not a recognisable Supabase endpoint/,
    mjsError: /not a recognisable Supabase endpoint/,
  },
  {
    name: "rejects a hostname that merely starts with the reference",
    identifier: REF,
    databaseUrl: `postgresql://postgres:pw@${REF}.evil.example:5432/postgres`,
    tsError: /not a recognisable Supabase endpoint/,
    mjsError: /not a recognisable Supabase endpoint/,
  },
  {
    name: "rejects an arbitrary remote host even when its database name matches",
    identifier: REF,
    databaseUrl: `postgresql://operator:pw@db.example.test:5432/${REF}`,
    tsError: /not a recognisable Supabase endpoint/,
    mjsError: /not a recognisable Supabase endpoint/,
  },
  {
    name: "rejects a remote host whose name equals the identifier",
    identifier: REF,
    databaseUrl: `postgresql://operator:pw@${REF}:5432/postgres`,
    tsError: /not a recognisable Supabase endpoint/,
    mjsError: /not a recognisable Supabase endpoint/,
  },
  {
    name: "rejects a pooler username that does not carry a project reference",
    identifier: REF,
    databaseUrl: "postgresql://postgres:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
    tsError: /could not be derived/,
    mjsError: /could not be derived/,
  },
  {
    name: "rejects a short identifier against a remote Supabase target",
    identifier: "hotel_saas_dev",
    databaseUrl: POOLED,
    tsError: /20-character Supabase project reference/,
    mjsError: /20-character Supabase project reference/,
  },
  {
    name: "rejects a loopback database whose name does not match the identifier",
    identifier: "hotel_saas_dev",
    databaseUrl: "postgresql://postgres:pw@127.0.0.1:5432/some_other_db",
    tsError: /does not match the approved SAAS_DATABASE_IDENTIFIER/,
    mjsError: /does not match the approved SAAS_DATABASE_IDENTIFIER/,
  },
  {
    name: "rejects a loopback DATABASE_URL paired with a remote DIRECT_URL",
    identifier: "hotel_saas_dev",
    databaseUrl: LOCAL,
    directUrl: DIRECT,
    tsError: /does not match|could not be derived|20-character/,
    mjsError: /does not match|could not be derived|20-character/,
  },
  {
    name: "rejects a malformed connection string",
    identifier: REF,
    databaseUrl: "not-a-url",
    tsError: /malformed/,
    mjsError: /valid PostgreSQL URL/,
  },
  {
    name: "rejects a non-postgres protocol",
    identifier: REF,
    databaseUrl: `mysql://postgres.${REF}:pw@aws-0-eu-central-1.pooler.supabase.com:3306/postgres`,
    tsError: /Unsupported database protocol/,
    mjsError: /postgres or postgresql protocol/,
  },
];

describe("Database identity — shared matrix (TypeScript guard)", () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const run = () =>
        assertDatabaseSafety(
          {
            saasEnvironment: "saas",
            saasDatabaseIdentifier: testCase.identifier,
            databaseUrl: testCase.databaseUrl,
            directUrl: testCase.directUrl,
          },
          testCase.requireDirect === undefined ? {} : { requireDirectUrl: testCase.requireDirect }
        );

      if (testCase.accepted) {
        expect(run).not.toThrow();
        return;
      }

      expect(run).toThrow(DatabaseSafetyError);
      expect(run).toThrow(testCase.tsError!);
    });
  }
});

describe("Database identity — shared matrix (standalone .mjs guard)", () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const run = () =>
        assertDatabaseTarget({
          environment: "saas",
          identifier: testCase.identifier,
          databaseUrl: testCase.databaseUrl,
          directUrl: testCase.directUrl,
          requireDirectUrl: testCase.requireDirect,
        });

      if (testCase.accepted) {
        expect(run).not.toThrow();
        return;
      }

      expect(run).toThrow(testCase.mjsError!);
    });
  }
});

describe("Database identity — details that both implementations must agree on", () => {
  it("reports the project reference and endpoint class for the approved target", () => {
    const ts = assertDatabaseSafety({ saasEnvironment: "saas", saasDatabaseIdentifier: REF, databaseUrl: POOLED, directUrl: DIRECT });
    const mjs = assertDatabaseTarget({ environment: "saas", identifier: REF, databaseUrl: POOLED, directUrl: DIRECT });

    expect(ts.kind).toBe("supabase-pooler");
    expect(ts.projectRef).toBe(REF);
    expect(ts.directKind).toBe("supabase-direct");
    expect(mjs.kind).toBe("supabase-pooler");
    expect(mjs.projectRef).toBe(REF);
    expect(mjs.directKind).toBe("supabase-direct");
  });

  it("never puts a password in an error message", () => {
    const password = "sup3r-s3cret";
    let tsMessage = "";
    let mjsMessage = "";

    try {
      assertDatabaseSafety({ saasEnvironment: "saas", saasDatabaseIdentifier: OTHER_REF, databaseUrl: POOLED });
    } catch (error) {
      tsMessage = (error as Error).message;
    }
    try {
      assertDatabaseTarget({ environment: "saas", identifier: OTHER_REF, databaseUrl: POOLED });
    } catch (error) {
      mjsMessage = (error as Error).message;
    }

    for (const message of [tsMessage, mjsMessage]) {
      expect(message).not.toContain(password);
      expect(message).toContain("does not match the approved SAAS_DATABASE_IDENTIFIER");
    }
  });

  it("fails closed when SAAS_ENVIRONMENT is not 'saas'", () => {
    expect(() => assertDatabaseTarget({ environment: "production", identifier: REF, databaseUrl: POOLED })).toThrow(
      /SAAS_ENVIRONMENT must be explicitly set to 'saas'/
    );
    expect(() =>
      assertDatabaseSafety({ saasEnvironment: "production", saasDatabaseIdentifier: REF, databaseUrl: POOLED })
    ).toThrow(/SAAS_ENVIRONMENT must be strictly 'saas'/);
  });

  it("treats 127.0.0.0/8 as loopback but 0.0.0.0 as remote", () => {
    expect(
      assertDatabaseTarget({
        environment: "saas",
        identifier: "hms_local",
        databaseUrl: "postgresql://postgres:pw@127.0.0.5:5432/hms_local",
      }).kind
    ).toBe("loopback");

    expect(() =>
      assertDatabaseTarget({
        environment: "saas",
        identifier: "hms_local",
        databaseUrl: "postgresql://postgres:pw@0.0.0.0:5432/hms_local",
      })
    ).toThrow(/not a recognisable Supabase endpoint/);
  });
});
