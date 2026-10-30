import { describe, it, expect } from "vitest";

import {
  APPLICATION_SCHEMA,
  SUPABASE_MANAGED_SCHEMAS,
  buildFilteredToc,
  parseToc,
  relationsIn,
  summariseToc,
} from "../../scripts/archive-toc.mjs";

/**
 * The owner's backup is a Supabase dump. Restoring it wholesale into a stock
 * PostgreSQL server fails partway through — which leaves a half-restored database
 * that looks like a success to anything checking only the exit code. These tests
 * cover the decision layer that prevents that: what the archive contains, what a
 * plain server can satisfy, and which TOC entries to comment out.
 *
 * The TOC text below is modelled on a real `pg_restore --list` of a Supabase
 * project (header, platform schemas, an extension, a publication, and the
 * application's own tables). It is a fixture, not a recording of the owner's
 * archive.
 */

const TOC = `;
; Archive created at 2026-10-28 14:08:23 EAT
;     dbname: postgres
;     TOC Entries: 19
;     Dump Version: 1.15-0
;     Format: CUSTOM
;
; Selected TOC Entries:
;
7; 2615 16388 SCHEMA - auth supabase_admin
8; 2615 16389 SCHEMA - extensions supabase_admin
9; 2615 16390 SCHEMA - supabase_migrations supabase_admin
2; 3079 16391 EXTENSION - pgcrypto
10; 3079 16392 EXTENSION - "uuid-ossp"
2619; 0 0 COMMENT - EXTENSION pgcrypto
221; 1259 16428 TABLE auth users postgres
223; 1259 16443 TABLE public "Guest" postgres
222; 1259 16436 TABLE public "Hotel" postgres
224; 1259 16456 TABLE supabase_migrations schema_migrations postgres
2609; 0 16428 TABLE DATA auth users postgres
2611; 0 16443 TABLE DATA public "Guest" postgres
2610; 0 16436 TABLE DATA public "Hotel" postgres
2612; 0 16456 TABLE DATA supabase_migrations schema_migrations postgres
2455; 2606 16435 CONSTRAINT auth users users_pkey postgres
2459; 2606 16449 CONSTRAINT public "Guest" "Guest_pkey" postgres
2457; 2606 16442 CONSTRAINT public "Hotel" "Hotel_pkey" postgres
2462; 2606 16450 FK CONSTRAINT public "Guest" "Guest_hotelId_fkey" postgres
2608; 6104 16455 PUBLICATION - supabase_realtime postgres
`;

describe("parseToc", () => {
  it("separates the header comments from the entries", () => {
    const parsed = parseToc(TOC);
    expect(parsed.header.length).toBeGreaterThan(5);
    expect(parsed.header.every((line) => line.startsWith(";"))).toBe(true);
    expect(parsed.entries).toHaveLength(19);
  });

  it("parses the identifiers, types, schemas and names", () => {
    const parsed = parseToc(TOC);
    const hotel = parsed.entries.find((entry) => entry.name === "Hotel" && entry.type === "TABLE");
    expect(hotel).toMatchObject({ schema: "public", owner: "postgres" });

    const data = parsed.entries.find((entry) => entry.type === "TABLE DATA" && entry.name === "Guest");
    expect(data).toMatchObject({ schema: "public" });

    // A constraint entry names a table, then the constraint: the constraint lands
    // in `owner`.
    const fk = parsed.entries.find((entry) => entry.type === "FK CONSTRAINT");
    expect(fk).toMatchObject({ schema: "public", name: "Guest", owner: '"Guest_hotelId_fkey"' });
  });

  it("puts a schema's own name in `name`, not `schema`", () => {
    const auth = parseToc(TOC).entries.find((entry) => entry.type === "SCHEMA" && entry.name === "auth");
    expect(auth).toBeDefined();
    expect(auth?.schema).toBeNull();
  });

  it("keeps an unrecognised line rather than dropping it", () => {
    const parsed = parseToc("not a toc line\n");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].type).toBe("UNPARSED");
    expect(parsed.entries[0].raw).toBe("not a toc line");
  });
});

describe("summariseToc", () => {
  const summary = summariseToc(parseToc(TOC));

  it("lists the schemas, including the ones the schema entries name", () => {
    expect(summary.schemas).toEqual(["auth", "extensions", "public", "supabase_migrations"]);
  });

  it("recognises a Supabase archive", () => {
    expect(summary.looksLikeSupabase).toBe(true);
    expect(summary.supabaseSchemas).toEqual(["auth", "extensions", "supabase_migrations"]);
    for (const schema of summary.supabaseSchemas) {
      expect(SUPABASE_MANAGED_SCHEMAS).toContain(schema);
    }
  });

  it("lists the extensions and the application tables", () => {
    expect(summary.extensions).toEqual(["pgcrypto", "uuid-ossp"]);
    expect(summary.applicationTables).toEqual(["Guest", "Hotel"]);
    expect(summary.supabaseOnlyObjectTypes).toEqual(["PUBLICATION"]);
  });

  it("compares the extensions against what the target can install", () => {
    const withAvailability = summariseToc(parseToc(TOC), { availableExtensions: ["pgcrypto", "plpgsql"] });
    expect(withAvailability.unavailableExtensions).toEqual(["uuid-ossp"]);
  });

  it("does not claim Supabase for an ordinary dump", () => {
    const plain = summariseToc(parseToc('223; 1259 16443 TABLE public "Guest" postgres\n'));
    expect(plain.looksLikeSupabase).toBe(false);
    expect(plain.supabaseSchemas).toEqual([]);
    expect(plain.applicationTables).toEqual(["Guest"]);
  });
});

describe("relationsIn", () => {
  it("returns only relations in the requested schema", () => {
    expect(relationsIn(parseToc(TOC), APPLICATION_SCHEMA).sort()).toEqual(["Guest", "Hotel"]);
    expect(relationsIn(parseToc(TOC), "auth")).toEqual(["users"]);
    expect(relationsIn(parseToc(TOC), "nope")).toEqual([]);
  });
});

describe("buildFilteredToc", () => {
  const excludeSchemas = ["auth", "supabase_migrations"];
  const filtered = buildFilteredToc(parseToc(TOC), {
    excludeSchemas,
    excludeExtensions: ["uuid-ossp"],
    excludeTypes: ["PUBLICATION"],
  });

  it("comments out the schema entry itself, not just its objects", () => {
    // This is the regression that let `auth` survive a filtered restore: the
    // schema's own TOC entry still ran, so the schema existed and its objects
    // were the only thing missing.
    const lines = filtered.text.split("\n");
    expect(lines).toContain("; 7; 2615 16388 SCHEMA - auth supabase_admin");
    expect(lines).toContain("; 221; 1259 16428 TABLE auth users postgres");
    expect(lines).toContain("; 2609; 0 16428 TABLE DATA auth users postgres");
  });

  it("keeps the application schema and its objects", () => {
    const lines = filtered.text.split("\n");
    expect(lines).toContain('223; 1259 16443 TABLE public "Guest" postgres');
    expect(lines).toContain('2611; 0 16443 TABLE DATA public "Guest" postgres');
    expect(lines).toContain('2462; 2606 16450 FK CONSTRAINT public "Guest" "Guest_hotelId_fkey" postgres');
  });

  it("keeps an available extension and drops an unavailable one", () => {
    const lines = filtered.text.split("\n");
    expect(lines).toContain("2; 3079 16391 EXTENSION - pgcrypto");
    expect(lines).toContain('; 10; 3079 16392 EXTENSION - "uuid-ossp"');
  });

  it("drops the Supabase-only object types", () => {
    expect(filtered.text).toContain("; 2608; 6104 16455 PUBLICATION - supabase_realtime postgres");
  });

  it("preserves the header and counts what it kept", () => {
    expect(filtered.text).toContain("; Selected TOC Entries:");
    expect(filtered.kept + filtered.excluded.length).toBe(19);
    expect(filtered.excluded.map((entry) => entry.reason).sort()).toEqual([
      "extension",
      "schema",
      "schema",
      "schema",
      "schema",
      "schema",
      "schema",
      "schema",
      "type",
    ]);
  });

  it("restores everything when nothing is excluded", () => {
    const parsed = parseToc(TOC);
    const unfiltered = buildFilteredToc(parsed);
    expect(unfiltered.excluded).toEqual([]);
    expect(unfiltered.kept).toBe(19);
    // Only the archive's own header comments remain: no entry line is commented.
    const lines = unfiltered.text.split("\n");
    expect(lines.filter((line) => line.startsWith(";"))).toEqual(parsed.header);
  });
});
