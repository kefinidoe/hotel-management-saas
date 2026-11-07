#!/usr/bin/env node
/**
 * Safety wrapper around the Prisma CLI.
 *
 * The gap this closes
 * -------------------
 * `prisma migrate deploy`, `prisma migrate dev` and `prisma studio` connect to
 * whatever `DATABASE_URL`/`DIRECT_URL` happen to resolve to. The Prisma CLI
 * cannot import `lib/db-safety-guard.ts`, so those commands used to run with no
 * identity check at all: the only thing between a stale `.env` and the legacy
 * Axis Hotel database was the operator remembering to run `npm run db:verify`
 * first.
 *
 * The documented npm Prisma database commands go through this wrapper, which
 * loads `.env` exactly like the Prisma CLI does, binds both URLs to
 * `SAAS_DATABASE_IDENTIFIER`, and then spawns the real CLI.
 *
 * Usage (the npm scripts call these forms):
 *   node scripts/prisma-safe.mjs migrate deploy
 *   node scripts/prisma-safe.mjs studio
 *   node scripts/prisma-safe.mjs guard            # verify only, run nothing
 *   node scripts/prisma-safe.mjs --print-target migrate deploy
 *
 * What this does NOT do
 * ---------------------
 * It cannot intercept `npx prisma ...` typed directly, because that starts the
 * Prisma CLI without passing through this repository's code. The CLI has no hook
 * mechanism in Prisma 5.x, and `package.json` cannot rewrite a binary invoked by
 * hand. The honest claim is therefore:
 *
 *   - the documented npm Prisma database commands use the wrapper;
 *     other scripts have separate safeguards;
 *   - a hand-typed `npx prisma <destructive verb>` is NOT intercepted.
 *
 * The mitigations for the remaining hole are documentary and procedural: the
 * policy in `docs/database-operation-policy.md`, the `db:verify` pre-flight, and
 * avoiding raw database commands; Prisma also loads .env automatically, so
 * merely omitting shell exports does not prevent an accidental connection.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, loadEnvFiles } from "./env-file.mjs";
import {
  DatabaseTargetSafetyError,
  assertDatabaseTarget,
  classifyDatabaseTarget,
} from "./database-target-safety.mjs";

const USAGE = `Usage: node scripts/prisma-safe.mjs [wrapper-options] <prisma command...>

wrapper-options:
  --print-target   Resolve and print the target, then exit without running Prisma.
  --json           Machine-readable output (use with --print-target).
  --quiet          Suppress the target banner.
  --help, -h       Show this text.

Guarded commands (must pass the SaaS identity check):
  migrate deploy | migrate status | migrate resolve | studio

Local-only commands (refused when the target is a remote database):
  migrate dev      Prisma creates and drops a shadow database on the target server.
  migrate reset    Drops and recreates the schema.
  db push          Not the approved schema workflow.
  db pull | db execute | db seed

Always refused:
  migrate diff | db push --force-reset | db push --accept-data-loss | prisma format

Unchanged: generate, validate, version.
`;

/** Commands that never open a database connection. */
const NO_DATABASE = new Set(["generate", "validate", "version", "format"]);

/**
 * Policy for the database-touching verbs.
 *
 * `remote: "allow" | "deny"` answers "may this run against a non-loopback
 * database?"; `denial` is the message used when it may not. `blockAlways` marks
 * a verb that is refused on every target. `requireDirect` mirrors what Prisma
 * actually needs.
 */
const MIGRATE_POLICY = {
  deploy: { remote: "allow", requireDirect: true, summary: "apply pending migrations" },
  status: { remote: "allow", requireDirect: true, summary: "read migration status" },
  resolve: { remote: "allow", requireDirect: true, summary: "mark a migration applied/rolled back" },
  diff: { remote: "deny", requireDirect: false, blockAlways: "migrate diff is disabled: its URL, schema and shadow database sources can bypass target validation." },
  dev: {
    remote: "deny",
    requireDirect: true,
    summary: "create and apply a migration (uses a shadow database)",
    denial:
      "prisma migrate dev is not permitted against a remote database: Prisma creates and drops a " +
      "shadow database on the target server. Use `npm run prisma:deploy` (migrate deploy).",
  },
  reset: {
    remote: "deny",
    requireDirect: true,
    summary: "drop and recreate the schema",
    denial:
      "prisma migrate reset is forbidden against any remote database: it drops every table and " +
      "replays the migration history. There is no repository-level confirmation that would make " +
      "this safe.",
    localFlag: "SAAS_ALLOW_LOCAL_RESET",
    localDenial:
      "prisma migrate reset is also destructive locally. If this loopback database is disposable, " +
      "re-run with SAAS_ALLOW_LOCAL_RESET=true.",
  },
};

const DB_POLICY = {
  push: {
    remote: "deny",
    requireDirect: false,
    summary: "push the schema without a migration",
    denial:
      "prisma db push is not the approved schema workflow and is refused for remote databases. " +
      "Use `npm run prisma:deploy` so every schema change is recorded in a migration.",
  },
  pull: { remote: "deny", requireDirect: false, summary: "introspect the database", denial: "prisma db pull is refused for remote databases." },
  execute: { remote: "deny", requireDirect: false, summary: "run arbitrary SQL", denial: "prisma db execute is refused for remote databases: it runs arbitrary SQL outside the migration ledger." },
  seed: { remote: "deny", requireDirect: false, summary: "run the seed script", denial: "prisma db seed is refused for remote databases." },
};

/** Flags that destroy data when combined with db push. */
const DESTRUCTIVE_FLAGS = new Set(["--force-reset", "--accept-data-loss"]);

function parseWrapperArgs(argv) {
  const wrapper = { printTarget: false, json: false, quiet: false, help: false };
  const rest = [];

  for (const arg of argv) {
    if (arg === "--print-target") wrapper.printTarget = true;
    else if (arg === "--json") wrapper.json = true;
    else if (arg === "--quiet") wrapper.quiet = true;
    else if (arg === "--help" || arg === "-h") wrapper.help = true;
    else rest.push(arg);
  }

  return { wrapper, prismaArgs: rest };
}

/**
 * Decide what the requested command is allowed to do.
 *
 * Unknown verbs are refused rather than passed through: a guard that silently
 * forwards `prisma <something-new> --yes` is not a guard.
 *
 * @param {string[]} args
 * @returns {{ kind: string, guard: boolean, remote: "allow"|"deny", requireDirect: boolean,
 *             denial?: string, localFlag?: string, localDenial?: string, summary?: string }}
 */
export function classifyPrismaCommand(args) {
  if (args.length === 0) {
    return { kind: "none", guard: false, remote: "allow", requireDirect: false, blockAlways: "No Prisma command given." };
  }

  const [verb, sub] = args;

  if (verb === "guard") {
    // Wrapper keyword: validate the environment as a migration would, run nothing.
    return {
      kind: "guard",
      guard: true,
      remote: "allow",
      requireDirect: true,
      summary: "verify the configured target only",
    };
  }

  if (NO_DATABASE.has(verb)) {
    if (verb === "format") {
      return {
        kind: "format",
        guard: false,
        remote: "allow",
        requireDirect: false,
        blockAlways:
          "prisma format rewrites prisma/schema.prisma. This repository does not run it: a formatter " +
          "run has silently reordered datasource blocks before. Format by hand.",
      };
    }
    return { kind: verb, guard: false, remote: "allow", requireDirect: false };
  }

  if (verb === "--version" || verb === "--help" || verb === "-v" || verb === "help") {
    return { kind: "meta", guard: false, remote: "allow", requireDirect: false };
  }

  if (verb === "migrate") {
    if (sub === undefined) {
      return {
        kind: "migrate",
        guard: false,
        remote: "allow",
        requireDirect: false,
        blockAlways: "`prisma migrate` needs a subcommand; unknown forms are refused. Use migrate deploy.",
      };
    }
    const policy = Object.hasOwn(MIGRATE_POLICY, sub) ? MIGRATE_POLICY[sub] : undefined;
    if (!policy) {
      return {
        kind: `migrate ${sub}`,
        guard: false,
        remote: "allow",
        requireDirect: false,
        blockAlways: "Unrecognised migrate subcommand. Refusing to run it unguarded.",
      };
    }
    return { kind: `migrate ${sub}`, guard: true, ...policy };
  }

  if (verb === "db") {
    if (sub === undefined) {
      return {
        kind: "db",
        guard: false,
        remote: "allow",
        requireDirect: false,
        blockAlways: "`prisma db` needs a subcommand; unknown forms are refused.",
      };
    }
    const policy = Object.hasOwn(DB_POLICY, sub) ? DB_POLICY[sub] : undefined;
    if (!policy) {
      return {
        kind: `db ${sub}`,
        guard: false,
        remote: "allow",
        requireDirect: false,
        blockAlways: "Unrecognised db subcommand. Refusing to run it unguarded.",
      };
    }
    return { kind: `db ${sub}`, guard: true, ...policy };
  }

  if (verb === "studio") {
    return { kind: "studio", guard: true, remote: "allow", requireDirect: false, summary: "open Prisma Studio" };
  }

  return {
    kind: verb,
    guard: false,
    remote: "allow",
    requireDirect: false,
    blockAlways: "Unrecognised Prisma command. Refusing to run it unguarded.",
  };
}

// Only known, non-datasource flags are forwarded for guarded commands. In
// particular, no URL, alternate schema source, shadow database or future flag
// is passed through merely because the environment URLs were checked.
const COMMAND_OPTIONS = {
  "guard": {},
  "validate": {},
  "generate": { "--no-engine": "flag", "--no-hints": "flag" },
  "migrate deploy": {},
  "migrate status": {},
  "migrate resolve": { "--applied": "value", "--rolled-back": "value" },
  "migrate dev": { "--name": "value", "--create-only": "flag", "--skip-generate": "flag", "--skip-seed": "flag" },
  "migrate reset": { "--force": "flag", "--skip-generate": "flag", "--skip-seed": "flag" },
  "db push": { "--skip-generate": "flag" },
  "db pull": { "--print": "flag", "--force": "flag" },
  "db execute": { "--file": "value", "--stdin": "flag" },
  "db seed": {},
  "studio": { "--port": "value", "--browser": "value" },
};

function validateArguments(args, kind) {
  const options = { ...COMMAND_OPTIONS[kind], "--schema": "schema" };
  const start = kind.includes(" ") ? 2 : 1;
  const seen = new Set();
  for (let i = start; i < args.length; i++) {
    const arg = args[i];
    const equal = arg.indexOf("=");
    const name = equal < 0 ? arg : arg.slice(0, equal);
    const type = Object.hasOwn(options, name) ? options[name] : undefined;
    if (!type || seen.has(name)) return "Unsupported or repeated Prisma argument; datasource overrides are forbidden.";
    seen.add(name);
    if (type === "flag") {
      if (equal >= 0) return "Boolean Prisma options cannot have a value.";
      continue;
    }
    const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
    if (!value || value.startsWith("-")) return "Prisma option is missing its value.";
    if (type === "schema" && !["prisma/schema.prisma", "./prisma/schema.prisma"].includes(value.replace(/\\/g, "/"))) {
      return "only prisma/schema.prisma is approved; alternate schemas are forbidden.";
    }
  }
  return null;
}

function fail(message) {
  process.stderr.write(`\n[PRISMA COMMAND BLOCKED] ${message}\n\n`);
  return 1;
}

function describeTarget(databaseUrl) {
  try {
    const parsed = new URL(String(databaseUrl).trim());
    const identity = classifyDatabaseTarget({
      host: parsed.hostname,
      userPrefix: parsed.username.split(".")[1],
    });
    return {
      host: parsed.hostname,
      port: parsed.port || "5432",
      database: parsed.pathname.replace(/^\//, ""),
      kind: identity.kind,
      projectRef: identity.projectRef ?? null,
    };
  } catch {
    return { host: "(unparseable)", port: "", database: "", kind: "invalid", projectRef: null };
  }
}

/** Find the Prisma CLI that `npm ci` installed. Never downloads one. */
export function resolvePrismaCli(root = REPO_ROOT) {
  const candidates = [
    join(root, "node_modules", "prisma", "build", "index.js"),
    join(root, "node_modules", "@prisma", "cli", "build", "index.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function runPrisma(cli, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: "inherit", env: process.env });
    child.on("error", (error) => {
      process.stderr.write(`Could not start the Prisma CLI: ${error.message}\n`);
      resolvePromise(1);
    });
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

function main(argv) {
  const { wrapper, prismaArgs } = parseWrapperArgs(argv);

  if (wrapper.help || prismaArgs.length === 0) {
    process.stdout.write(USAGE);
    return wrapper.help ? 0 : 2;
  }

  // Load .env exactly as the Prisma CLI would, so the guard judges the same
  // values the CLI is about to use.
  loadEnvFiles({ rootDir: REPO_ROOT });

  const policy = classifyPrismaCommand(prismaArgs);
  const environment = process.env.SAAS_ENVIRONMENT;
  const identifier = process.env.SAAS_DATABASE_IDENTIFIER;
  const databaseUrl = process.env.DATABASE_URL;
  const directUrl = process.env.DIRECT_URL;

  const report = (payload) => {
    if (wrapper.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  };

  // Destructive flags are refused before anything else is considered.
  for (const flag of prismaArgs) {
    if (DESTRUCTIVE_FLAGS.has(flag)) {
      const reason =
        `'${flag}' is a destructive flag and is refused. It drops data without the migration ledger ` +
        "noticing, and is exactly the kind of command that must never reach a shared database.";
      if (wrapper.printTarget) report({ command: policy.kind, decision: "deny", reason });
      return fail(reason);
    }
  }

  if (policy.blockAlways) {
    if (wrapper.printTarget) {
      report({ command: policy.kind, decision: "deny", reason: policy.blockAlways });
      process.stderr.write(`${policy.blockAlways}\n`);
      return 1;
    }
    return fail(policy.blockAlways);
  }

  if (!policy.guard) {
    if (["generate", "validate"].includes(policy.kind)) {
      const argumentError = validateArguments(prismaArgs, policy.kind);
      if (argumentError) return fail(argumentError);
    }
    // generate / validate / version: no database connection is opened.
    if (wrapper.printTarget) {
      report({ command: policy.kind, decision: "allow", reason: "no database connection" });
      return 0;
    }
    return spawnAndExit(prismaArgs);
  }


  // A different schema file can read its datasource URL from a different variable,
  // which would let Prisma connect somewhere the guard never looked at.
  const argumentError = validateArguments(prismaArgs, policy.kind);
  if (argumentError !== null) {
    const reason = argumentError;
    if (wrapper.printTarget) report({ command: policy.kind, decision: "deny", reason });
    return fail(reason);
  }

  // libpq-based clients and engines can inherit connection defaults independently
  // of the URI. Do not let hostaddr or service settings redirect a guarded call.
  if (["PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE"].some((key) => process.env[key])) {
    return fail("PostgreSQL target-related environment defaults must be unset for guarded Prisma commands.");
  }

  let target;
  try {
    assertDatabaseTarget({
      environment,
      identifier,
      databaseUrl,
      directUrl,
      requireDirectUrl: policy.requireDirect,
    });
    target = describeTarget(databaseUrl);
  } catch (error) {
    if (!(error instanceof DatabaseTargetSafetyError)) throw error;
    const message = error.message;

    if (wrapper.printTarget) {
      report({ command: policy.kind, decision: "deny", reason: message });
      process.stderr.write(`${message}\n`);
      return 1;
    }

    process.stderr.write(`\n${message}\n`);
    process.stderr.write(
      "\nNothing was executed. Run `npm run db:verify` to see which database is configured, and set " +
        "SAAS_ENVIRONMENT=saas, SAAS_DATABASE_IDENTIFIER and both URLs explicitly.\n\n"
    );
    return 1;
  }

  // The guard passed. Now apply the "remote is not allowed" rules.
  const isRemote = target.kind !== "loopback";

  if (isRemote && policy.remote === "deny") {
    const reason = policy.denial ?? `${policy.kind} is not permitted against a remote database.`;
    if (wrapper.printTarget) report({ command: policy.kind, decision: "deny", reason, target });
    return fail(reason);
  }

  if (!isRemote && policy.localFlag && process.env[policy.localFlag] !== "true") {
    const reason = policy.localDenial ?? `${policy.kind} is destructive; set ${policy.localFlag}=true to confirm.`;
    if (wrapper.printTarget) report({ command: policy.kind, decision: "deny", reason, target });
    return fail(reason);
  }

  if (policy.kind === "guard") {
    const summary = {
      command: "guard",
      decision: "allow",
      target,
      identifier,
      message: "environment and both URLs match the approved SaaS identity; nothing was executed",
    };
    if (wrapper.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else {
      process.stdout.write(
        `[prisma-safe] target: ${target.kind} ${target.host}:${target.port}/${target.database}` +
          `${target.projectRef ? ` (project ${target.projectRef})` : ""}\n` +
          `[prisma-safe] identity: ${identifier}\n` +
          "[prisma-safe] OK — environment and both URLs match the approved SaaS identity; nothing was executed.\n"
      );
    }
    return 0;
  }

  if (wrapper.printTarget) {
    report({ command: policy.kind, decision: "allow", target });
    if (!wrapper.json) {
      process.stdout.write(
        `ALLOW ${policy.kind} -> ${target.kind} ${target.host}:${target.port}/${target.database}` +
          `${target.projectRef ? ` (project ${target.projectRef})` : ""}\n`
      );
    }
    return 0;
  }

  if (!wrapper.quiet) {
    process.stdout.write(
      `\n[prisma-safe] ${policy.kind}${policy.summary ? ` — ${policy.summary}` : ""}\n` +
        `[prisma-safe] target: ${target.kind} ${target.host}:${target.port}/${target.database}` +
        `${target.projectRef ? ` (project ${target.projectRef})` : ""}\n` +
        `[prisma-safe] identity: ${identifier}\n\n`
    );
  }

  return spawnAndExit(prismaArgs);
}

function spawnAndExit(prismaArgs) {
  const cli = resolvePrismaCli();
  if (!cli) {
    return fail(
      "the Prisma CLI is not installed in node_modules. Run `npm ci` first. This wrapper never " +
        "downloads a CLI, because a floating `npx prisma` would resolve a version this repository " +
        "has not pinned or tested."
    );
  }
  // Returned as a promise so the caller can await; `main` is awaited below.
  return runPrisma(cli, prismaArgs);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  Promise.resolve(main(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`\n[PRISMA COMMAND BLOCKED] ${error instanceof Error ? error.message : String(error)}\n\n`);
      process.exitCode = 1;
    });
}
