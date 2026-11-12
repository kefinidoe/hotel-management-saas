#!/usr/bin/env node
/**
 * Verify the migration set and the adoption tooling against the REAL Prisma
 * migration engine.
 *
 * Why this harness exists
 * -----------------------
 * The application is pinned to `prisma@5.17.0`, whose engine binaries are only
 * published to `binaries.prisma.sh`. That host is not reachable from every
 * build/CI sandbox, and Prisma publishes no 5.x WebAssembly schema engine, so a
 * 5.17.0 engine binary cannot always be obtained. Prisma 6.19.0 ships the same
 * Rust schema engine compiled to WebAssembly inside the npm package, and
 * `@prisma/migrate` 6.19.0 exposes the exact command implementations behind
 * `prisma migrate deploy`, `prisma migrate resolve --applied` and
 * `prisma migrate status`. Driving those implementations gives us the real
 * ledger writer, the real checksum algorithm, the real transactional apply and
 * the real drift detection instead of the psql emulation used by
 * `scripts/migration-rehearsal.mjs`.
 *
 * This harness is verification-only. It does not change the pinned Prisma
 * version, is not imported by the application, and expects a throwaway
 * PostgreSQL server plus a separate install of the 6.19.0 tool stack (see the
 * "Engine verification" section of docs/migration-strategy.md).
 *
 * Usage
 *   VERIFY_BASE_URL=postgresql://postgres@127.0.0.1:55432 \
 *   VERIFY_MODULES=/tmp/prisma-engine-verify/node_modules \
 *   node scripts/prisma-engine-verify.mjs [fresh|legacy|saas18|interop|conflict|failure|all]
 *
 * Optional
 *   VERIFY_KEEP=1     keep the disposable databases for inspection
 *   VERIFY_PSQL=...   psql binary used by the adoption-tool scenario
 *
 * Scenarios
 *   fresh     real engine applies all migrations to an empty database
 *   legacy    migrations 1-11 present without a ledger, resolved + deployed by the engine
 *   saas18    migrations 1-18 present after migrations 18 and 19 were authored
 *   interop   ledger written by scripts/migrate-adopt.mjs, then inspected by the engine
 *   conflict  a tampered ledger checksum is detected by the engine and by the adoption tool
 *   failure   migration 19 aborts on a cross-tenant row, is recorded as failed, then recovers
 */
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PRISMA_LEDGER_DDL,
  buildFeatureQuery,
  crlfWarnings,
  evaluateCheckpoints,
  readMigrations,
  readReleaseManifest,
  repoRoot,
} from './migration-ledger.mjs'

const BASE_URL = process.env.VERIFY_BASE_URL ?? 'postgresql://postgres@127.0.0.1:5432'
const MODULES = process.env.VERIFY_MODULES ?? '/tmp/prisma-engine-verify/node_modules'
const PSQL = process.env.VERIFY_PSQL ?? 'psql'
const KEEP = process.env.VERIFY_KEEP === '1'
const DB_PREFIX = 'prisma_engine_verify_'

const migrations = readMigrations()
for (const warning of crlfWarnings(migrations)) process.stderr.write(`! ${warning}\n`)
const manifest = readReleaseManifest()
const names = migrations.map((migration) => migration.name)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`)
  return ok
}
function section(title) {
  process.stdout.write(`\n== ${title}\n`)
}

function requireVerificationModules() {
  const requireFromModules = createRequire(path.join(MODULES, 'noop.js'))
  const missing = []
  const load = (id) => {
    try {
      return requireFromModules(id)
    } catch {
      missing.push(id)
      return null
    }
  }
  const modules = {
    Migrate: load('@prisma/migrate')?.Migrate,
    loadSchemaContext: load('@prisma/internals')?.loadSchemaContext,
    PrismaPg: load('@prisma/adapter-pg')?.PrismaPg,
    bindMigrationAwareSqlAdapterFactory: load('@prisma/driver-adapter-utils')
      ?.bindMigrationAwareSqlAdapterFactory,
    Client: load('pg')?.Client,
  }
  if (missing.length > 0) {
    throw new Error(
      `Verification modules are missing from ${MODULES}: ${missing.join(', ')}.\n` +
        'Install the 6.19.0 tool stack there; see docs/migration-strategy.md ("Engine verification").',
    )
  }
  return modules
}

const {
  Migrate,
  loadSchemaContext,
  PrismaPg,
  bindMigrationAwareSqlAdapterFactory,
  Client,
} = requireVerificationModules()

/**
 * `@prisma/internals` reads the WebAssembly schema engine from its own
 * `build/` directory, which the published tarball does not include. The engine
 * bytes are shipped in `prisma/build/schema_engine_bg.wasm` and in
 * `@prisma/schema-engine-wasm`; copy the byte-identical file into place and
 * verify the digest so the harness never runs a substituted engine.
 */
function ensureWasmEngine() {
  const internalsBuild = path.join(MODULES, '@prisma', 'internals', 'build')
  const target = path.join(internalsBuild, 'schema_engine_bg.wasm')
  const candidates = [
    path.join(MODULES, '@prisma', 'schema-engine-wasm', 'schema_engine_bg.wasm'),
    path.join(MODULES, 'prisma', 'build', 'schema_engine_bg.wasm'),
  ].filter((candidate) => fs.existsSync(candidate))
  if (candidates.length === 0) {
    throw new Error(
      `Could not find schema_engine_bg.wasm in ${MODULES}. Install @prisma/schema-engine-wasm alongside @prisma/migrate.`,
    )
  }
  const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const source = candidates[0]
  const digest = sha256(source)
  for (const candidate of candidates) {
    if (sha256(candidate) !== digest) {
      throw new Error(`WASM schema engine copies disagree: ${source} vs ${candidate}`)
    }
  }
  if (!fs.existsSync(target) || sha256(target) !== digest) {
    fs.mkdirSync(internalsBuild, { recursive: true })
    fs.copyFileSync(source, target)
  }
  return { digest, source, copiesAgreed: candidates.length > 1 }
}

/**
 * @prisma/adapter-pg implements executeScript() as `script.split(";")`, which
 * corrupts any migration whose comments or string literals contain a semicolon.
 * The Schema Engine itself hands the whole script to the adapter in a single
 * call (sql-schema-connector/flavour/postgres/connector/wasm -> execute_script),
 * so the faithful implementation is one multi-statement simple query, which is
 * what the native engine's raw_cmd does. Everything else is untouched
 * adapter-pg behaviour.
 */
function fidelityAdapterFactory(connectionString, capture) {
  const base = new PrismaPg({ connectionString })
  return {
    provider: base.provider,
    adapterName: base.adapterName,
    async connect() {
      const adapter = await base.connect()
      adapter.executeScript = async (script) => {
        capture.scripts.push(script)
        try {
          await adapter.underlyingDriver().query(script)
        } catch (error) {
          // The driver-adapter protocol reports the SQL error to the engine as an
          // opaque "external connector error" id; capture the real message here.
          capture.errors.push(error)
          throw error
        }
      }
      return adapter
    },
    connectToShadowDb: () => base.connectToShadowDb(),
  }
}

async function openMigrate(databaseUrl, capture) {
  const connectionString = databaseUrl
  const schemaEngineConfig = {
    engine: 'js',
    adapter: async () =>
      bindMigrationAwareSqlAdapterFactory(fidelityAdapterFactory(connectionString, capture)),
  }
  const schemaContext = await loadSchemaContext({
    schemaPathFromArg: path.join(repoRoot, 'prisma', 'schema.prisma'),
    schemaEngineConfig,
    printLoadMessage: false,
    ignoreEnvVarErrors: true,
  })
  return Migrate.setup({
    schemaContext,
    schemaEngineConfig,
    migrationsDirPath: path.join(repoRoot, 'prisma', 'migrations'),
  })
}

async function withMigrate(databaseUrl, run) {
  const capture = { scripts: [], errors: [] }
  const migrate = await openMigrate(databaseUrl, capture)
  try {
    return await run(migrate, capture)
  } finally {
    await migrate.stop()
  }
}

function adminUrl(databaseName = 'postgres') {
  const url = new URL(BASE_URL)
  url.pathname = `/${databaseName}`
  return url.toString()
}
function databaseUrl(databaseName) {
  return adminUrl(databaseName)
}
async function query(databaseName, sql, params) {
  const client = new Client({ connectionString: adminUrl(databaseName) })
  await client.connect()
  try {
    return (await client.query(sql, params)).rows
  } finally {
    await client.end()
  }
}
async function createDisposableDatabase(suffix) {
  const name = `${DB_PREFIX}${suffix}`
  const client = new Client({ connectionString: adminUrl() })
  await client.connect()
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await client.query(`CREATE DATABASE "${name}"`)
  } finally {
    await client.end()
  }
  return name
}
async function dropDisposableDatabase(name) {
  if (KEEP) {
    process.stdout.write(`KEEP  database ${name} left in place (VERIFY_KEEP=1)\n`)
    return
  }
  const client = new Client({ connectionString: adminUrl() })
  await client.connect()
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  } finally {
    await client.end()
  }
}
async function applyRawSql(databaseName, migrationNames) {
  const client = new Client({ connectionString: databaseUrl(databaseName) })
  await client.connect()
  try {
    for (const name of migrationNames) {
      const file = path.join(repoRoot, 'prisma', 'migrations', name, 'migration.sql')
      await client.query(fs.readFileSync(file, 'utf8'))
    }
  } finally {
    await client.end()
  }
}
async function ledgerRows(databaseName) {
  return query(
    databaseName,
    `SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count
       FROM "_prisma_migrations" ORDER BY started_at`,
  )
}
async function hasLedger(databaseName) {
  const rows = await query(
    databaseName,
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = '_prisma_migrations'`,
  )
  return rows[0].n === 1
}
async function detectCheckpoint(databaseName) {
  // buildFeatureQuery() returns a single JSON column, exactly as
  // scripts/migrate-adopt.mjs consumes it.
  const rows = await query(databaseName, buildFeatureQuery())
  const features = typeof rows[0].features === 'string' ? JSON.parse(rows[0].features) : rows[0].features
  return evaluateCheckpoints(features)
}
async function checksumMismatches(databaseName) {
  const reviewed = new Map(manifest.migrations.map((migration) => [migration.name, migration.sha256]))
  const rows = await ledgerRows(databaseName)
  return rows.filter((row) => reviewed.get(row.migration_name) !== row.checksum)
}
function runAdoptionTool(args, env = {}) {
  return spawnSync('node', [path.join(repoRoot, 'scripts', 'migrate-adopt.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, SAAS_ENVIRONMENT: 'saas', ...env },
  })
}

// ---------------------------------------------------------------- scenarios

async function scenarioFresh(wasm) {
  section('fresh — the engine applies every migration to an empty database')
  const db = await createDisposableDatabase('fresh')
  try {
    const result = await withMigrate(databaseUrl(db), async (migrate, capture) => {
      const started = Date.now()
      const applied = await migrate.applyMigrations()
      return {
        applied: applied.appliedMigrationNames,
        ms: Date.now() - started,
        scripts: capture.scripts,
      }
    })
    check('engine reported success', true, `${result.ms} ms, ${result.scripts.length} script(s) executed`)
    const verbatim = names.every((name, index) => {
      const file = fs
        .readFileSync(path.join(repoRoot, 'prisma', 'migrations', name, 'migration.sql'), 'utf8')
        .trim()
      return file === (result.scripts[index] ?? '').trim()
    })
    check('engine executed the migration files verbatim', verbatim)
    check(
      'engine applied all migrations in directory order',
      JSON.stringify(result.applied) === JSON.stringify(names),
      `${result.applied.length}/${names.length}`,
    )
    const rows = await ledgerRows(db)
    check('ledger contains one row per migration', rows.length === names.length, `rows=${rows.length}`)
    check(
      'every row is finished and none is rolled back',
      rows.every((row) => row.finished_at && !row.rolled_back_at),
    )
    const mismatches = await checksumMismatches(db)
    check(
      'engine-recorded checksums equal the release manifest',
      mismatches.length === 0,
      `${rows.length - mismatches.length}/${rows.length} identical`,
    )
    check(
      'applied_steps_count is recorded per migration',
      rows.every((row) => row.applied_steps_count >= 1),
    )
    const checkpoints = await detectCheckpoint(db)
    check('schema fingerprint is saas_current', checkpoints.includes('saas_current'), checkpoints.join(','))

    // Our adoption tool creates the ledger before inserting baselines; make sure
    // the DDL it uses is indistinguishable from the engine's own DDL.
    const engineColumns = await query(
      db,
      `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema='public' AND table_name='_prisma_migrations'
        ORDER BY ordinal_position`,
    )
    const ours = PRISMA_LEDGER_DDL.replace('"_prisma_migrations"', '"_prisma_migrations_expected"')
    await query(db, ours)
    const toolColumns = await query(
      db,
      `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema='public' AND table_name='_prisma_migrations_expected'
        ORDER BY ordinal_position`,
    )
    const normalise = (rows) => JSON.stringify(rows)
    check(
      'migration-ledger.mjs ledger DDL matches the engine ledger exactly',
      normalise(engineColumns) === normalise(toolColumns),
      `${engineColumns.length} columns compared`,
    )
  } finally {
    await dropDisposableDatabase(db)
  }
}

async function scenarioLegacy() {
  section('legacy — single-hotel database (migrations 1-11, no ledger)')
  const db = await createDisposableDatabase('legacy')
  try {
    await applyRawSql(db, names.slice(0, 11))
    check('starting database has no migration ledger', (await hasLedger(db)) === false)

    await withMigrate(databaseUrl(db), async (migrate) => {
      for (const name of names.slice(0, 11)) {
        await migrate.markMigrationApplied({ migrationId: name })
      }
    })
    const resolved = await ledgerRows(db)
    check('engine recorded 11 baselines', resolved.length === 11, `rows=${resolved.length}`)
    check(
      'baselines are finished with applied_steps_count = 0',
      resolved.every((row) => row.finished_at && row.applied_steps_count === 0),
    )
    const deployed = await withMigrate(databaseUrl(db), async (migrate) => {
      const applied = await migrate.applyMigrations()
      return applied.appliedMigrationNames
    })
    check(
      'engine deployed exactly the pending migrations',
      JSON.stringify(deployed) === JSON.stringify(names.slice(11)),
      `${deployed.length} applied`,
    )
    const mismatches = await checksumMismatches(db)
    check('baselines and deployments match the release manifest', mismatches.length === 0)
    const checkpoints = await detectCheckpoint(db)
    check('schema fingerprint is saas_current', checkpoints.includes('saas_current'), checkpoints.join(','))
    const again = await withMigrate(databaseUrl(db), async (migrate) => {
      const applied = await migrate.applyMigrations()
      return applied.appliedMigrationNames
    })
    check('a second deploy is a no-op', again.length === 0, `${again.length} applied`)
  } finally {
    await dropDisposableDatabase(db)
  }
}

async function scenarioSaas18() {
  section('saas18 — database created after migrations 18 and 19 were authored')
  const db = await createDisposableDatabase('saas18')
  try {
    await applyRawSql(db, names.slice(0, 18))
    await withMigrate(databaseUrl(db), async (migrate) => {
      for (const name of names.slice(0, 18)) {
        await migrate.markMigrationApplied({ migrationId: name })
      }
    })
    const deployed = await withMigrate(databaseUrl(db), async (migrate) => {
      const applied = await migrate.applyMigrations()
      return applied.appliedMigrationNames
    })
    check(
      'engine deployed only the last migration',
      JSON.stringify(deployed) === JSON.stringify(names.slice(18)),
      JSON.stringify(deployed),
    )
    const checkpoints = await detectCheckpoint(db)
    check('schema fingerprint is saas_current', checkpoints.includes('saas_current'), checkpoints.join(','))
  } finally {
    await dropDisposableDatabase(db)
  }
}

async function scenarioInterop() {
  section('interop — ledger written by scripts/migrate-adopt.mjs, read back by the engine')
  const db = await createDisposableDatabase('interop')
  try {
    await applyRawSql(db, names.slice(0, 11))
    const adoption = runAdoptionTool(
      [
        '--url', databaseUrl(db),
        '--psql', PSQL,
        '--execute',
        '--approved-by', 'verify@localhost',
        '--confirm-database', db,
        '--apply-pending-with-psql',
      ],
      { SAAS_DATABASE_IDENTIFIER: db },
    )
    check('migrate-adopt --execute exit 0', adoption.status === 0, (adoption.stderr || '').trim().split('\n').pop() ?? '')
    check(
      'adoption tool reports saas_current after its run',
      /Checkpoint after this run: saas_current/.test(adoption.stdout),
    )
    const deployed = await withMigrate(databaseUrl(db), async (migrate) => {
      const applied = await migrate.applyMigrations()
      return applied.appliedMigrationNames
    })
    check('engine sees nothing left to deploy', deployed.length === 0, JSON.stringify(deployed))
    const diagnosis = await withMigrate(databaseUrl(db), async (migrate) =>
      migrate.diagnoseMigrationHistory({ optInToShadowDatabase: false }),
    )
    check('engine finds a migrations table', diagnosis.hasMigrationsTable === true)
    check(
      'engine reports no edited migrations',
      (diagnosis.editedMigrationNames ?? []).length === 0,
      JSON.stringify(diagnosis.editedMigrationNames ?? []),
    )
    check(
      'engine reports no failed migrations',
      (diagnosis.failedMigrationNames ?? []).length === 0,
      JSON.stringify(diagnosis.failedMigrationNames ?? []),
    )
    const mismatches = await checksumMismatches(db)
    check('tool-written checksums match the release manifest', mismatches.length === 0)
    const checkpoints = await detectCheckpoint(db)
    check('schema fingerprint is saas_current', checkpoints.includes('saas_current'), checkpoints.join(','))
  } finally {
    await dropDisposableDatabase(db)
  }
}

async function scenarioConflict() {
  section('conflict — a migration changed after it was applied')
  const db = await createDisposableDatabase('conflict')
  try {
    await withMigrate(databaseUrl(db), async (migrate) => {
      await migrate.applyMigrations()
    })
    const target = names[names.length - 1]
    await query(db, `UPDATE "_prisma_migrations" SET checksum = repeat('0', 64) WHERE migration_name = $1`, [target])
    const diagnosis = await withMigrate(databaseUrl(db), async (migrate) =>
      migrate.diagnoseMigrationHistory({ optInToShadowDatabase: false }),
    )
    check(
      'engine flags the edited migration',
      JSON.stringify(diagnosis.editedMigrationNames ?? []) === JSON.stringify([target]),
      JSON.stringify(diagnosis.editedMigrationNames ?? []),
    )
    const dryRun = runAdoptionTool(['--url', databaseUrl(db), '--psql', PSQL], {
      SAAS_DATABASE_IDENTIFIER: db,
    })
    check('adoption tool refuses to proceed', dryRun.status === 1, `exit ${dryRun.status}`)
    check(
      'adoption tool names the mismatching migration',
      dryRun.stdout.includes(target) && /Checksum mismatch/.test(dryRun.stdout),
    )
  } finally {
    await dropDisposableDatabase(db)
  }
}

// Fixture from __tests__/schema/fixtures/pre-saas-conversion.sql, paired with a
// deliberately cross-tenant ReservationRoom row: the reservation belongs to
// hotel-a while the room belongs to hotel-b.
const CROSS_TENANT_FIXTURE = `INSERT INTO "Hotel" (id, name, slug, "updatedAt") VALUES ('hotel-a', 'Hotel A', 'hotel-a', now()), ('hotel-b', 'Hotel B', 'hotel-b', now());
INSERT INTO "User" (id, name, email, "passwordHash", "updatedAt") VALUES ('staff-a', 'Staff A', 'staff-a@example.test', 'hash', now());
INSERT INTO "RoomType" (id, "hotelId", name, "baseRate", capacity, "updatedAt") VALUES ('rt-a', 'hotel-a', 'Standard', 100, 1, now()), ('rt-b', 'hotel-b', 'Standard', 100, 1, now());
INSERT INTO "Room" (id, "hotelId", number, "roomTypeId", "updatedAt") VALUES ('room-a', 'hotel-a', '101', 'rt-a', now()), ('room-b', 'hotel-b', '201', 'rt-b', now());
INSERT INTO "Guest" (id, "hotelId", "fullName", "updatedAt") VALUES ('guest-a', 'hotel-a', 'Guest A', now());
INSERT INTO "Reservation" (id, "hotelId", code, "guestId", "createdById", "checkInDate", "checkOutDate", "updatedAt")
  VALUES ('res-a', 'hotel-a', 'RES-A', 'guest-a', 'staff-a', now(), now() + interval '1 day', now());
INSERT INTO "ReservationRoom" (id, "reservationId", "roomId", rate) VALUES ('rr-bad', 'res-a', 'room-b', 100);`

async function constraintNames(databaseName, tableName) {
  const rows = await query(
    databaseName,
    `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`,
    [tableName],
  )
  return rows.map((row) => row.conname)
}

async function scenarioFailure() {
  section('failure — migration 19 aborts on a cross-tenant row, then recovers')
  const db = await createDisposableDatabase('failure')
  try {
    await applyRawSql(db, names.slice(0, 17))
    {
      const client = new Client({ connectionString: databaseUrl(db) })
      await client.connect()
      try {
        await client.query(CROSS_TENANT_FIXTURE)
      } finally {
        await client.end()
      }
    }
    await withMigrate(databaseUrl(db), async (migrate) => {
      for (const name of names.slice(0, 17)) {
        await migrate.markMigrationApplied({ migrationId: name })
      }
    })
    const target = names[names.length - 1]
    let failure = null
    let driverErrors = []
    try {
      await withMigrate(databaseUrl(db), async (migrate, capture) => {
        try {
          await migrate.applyMigrations()
        } finally {
          driverErrors = capture.errors
        }
      })
    } catch (error) {
      failure = error
    }
    check('engine aborts the deploy', failure !== null, (failure?.message ?? '').split('\n')[0].slice(0, 90))
    check(
      'the rejected statement is the migration-19 tenant precheck',
      /Tenant-integrity precheck failed/.test(String(driverErrors[0]?.message ?? '')) &&
        /ReservationRoom/.test(String(driverErrors[0]?.message ?? '')),
      String(driverErrors[0]?.message ?? '').slice(0, 110),
    )
    const rows = await ledgerRows(db)
    const failedRow = rows.find((row) => row.migration_name === target)
    const finished = rows.filter((row) => row.finished_at && !row.rolled_back_at)
    check('the last successful migration is recorded', finished.length === names.length - 1, `${finished.length} finished`)
    check('the failed migration is recorded as failed', Boolean(failedRow) && failedRow.finished_at === null, JSON.stringify({ finished_at: failedRow?.finished_at ?? null }))
    const logs = await query(db, `SELECT logs FROM "_prisma_migrations" WHERE migration_name = $1`, [target])
    check(
      'the failed migration keeps the engine error in logs',
      Boolean(logs[0]?.logs) && /external connector error/i.test(logs[0].logs),
      (logs[0]?.logs ?? '').split('\n')[0].slice(0, 80),
    )
    const constraints = await constraintNames(db, '"ReservationRoom"')
    check(
      'the aborted script left no partial schema change',
      constraints.includes('ReservationRoom_reservationId_fkey') &&
        !constraints.includes('ReservationRoom_reservationId_hotelId_fkey'),
      `${constraints.length} constraints`,
    )

    // Prisma's documented recovery: repair the data, mark the failed migration
    // rolled back, then deploy again.
    await query(db, `UPDATE "ReservationRoom" SET "roomId" = 'room-a' WHERE id = 'rr-bad'`)
    await withMigrate(databaseUrl(db), async (migrate) => {
      await migrate.markMigrationRolledBack({ migrationId: target })
    })
    const recovered = await withMigrate(databaseUrl(db), async (migrate) => {
      const applied = await migrate.applyMigrations()
      return applied.appliedMigrationNames
    })
    check('engine redeploys the recovered migration', JSON.stringify(recovered) === JSON.stringify([target]), JSON.stringify(recovered))
    const checkpoints = await detectCheckpoint(db)
    check('schema fingerprint is saas_current after recovery', checkpoints.includes('saas_current'), checkpoints.join(','))
  } finally {
    await dropDisposableDatabase(db)
  }
}

// ---------------------------------------------------------------- entrypoint

const requested = (process.argv[2] ?? 'all').split(',').map((value) => value.trim())
const scenarios = {
  fresh: scenarioFresh,
  legacy: scenarioLegacy,
  saas18: scenarioSaas18,
  interop: scenarioInterop,
  conflict: scenarioConflict,
  failure: scenarioFailure,
}
const selected = requested.includes('all') ? Object.keys(scenarios) : requested
for (const name of selected) {
  if (!scenarios[name]) throw new Error(`Unknown scenario '${name}'. Use: ${Object.keys(scenarios).join(', ')}, all`)
}

const wasm = ensureWasmEngine()
const coreVersion = createRequire(path.join(MODULES, 'noop.js'))('@prisma/migrate/package.json').version
const prismaVersion = createRequire(path.join(MODULES, 'noop.js'))('prisma/package.json').version
process.stdout.write('Prisma engine verification\n')
process.stdout.write(`  base url            : ${BASE_URL.replace(/:[^:@/]*@/, ':***@')}\n`)
process.stdout.write(`  @prisma/migrate     : ${coreVersion}\n`)
process.stdout.write(`  prisma (tool stack) : ${prismaVersion}\n`)
process.stdout.write(`  wasm schema engine  : ${wasm.digest}\n`)
process.stdout.write(`  migrations          : ${migrations.length}\n`)
process.stdout.write(`  scenarios           : ${selected.join(', ')}\n`)

for (const name of selected) {
  await scenarios[name](wasm)
}

const failed = results.filter((result) => !result.ok)
process.stdout.write(
  `\n${failed.length === 0 ? 'ENGINE VERIFICATION PASSED' : 'ENGINE VERIFICATION FAILED'}: ` +
    `${results.length - failed.length}/${results.length} assertions\n`,
)
if (failed.length > 0) {
  for (const result of failed) process.stdout.write(`  failed: ${result.name}${result.detail ? ` (${result.detail})` : ''}\n`)
  process.exitCode = 1
}
