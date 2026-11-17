#!/usr/bin/env node
/**
 * Verify that a supplied Prisma engine pair really is the pinned 5.17.0 release,
 * and — when a CLI is supplied — that Prisma 5.17.0 resolves to it.
 *
 * The point of this script is that "we obtained the official binaries" should be
 * an assertion a machine can check, not a sentence in a report. It refuses to
 * call an engine verified on the strength of a filename, a version string, or
 * the fact that it runs: the bytes must match the official digests in
 * scripts/prisma-engine-pins.mjs, and `schema-engine --version` must name the
 * pinned commit. A build from another commit that still says "5.17" somewhere
 * fails both checks.
 *
 * What this does not do: obtain the binaries, or run migrations. Downloading is
 * §7.1.2 of docs/migration-strategy.md (the CDN is not reachable from this
 * environment), and running them is the §4.2–4.6 runbook against a restored
 * copy — which is only worth doing once this script says PASS.
 *
 * Usage:
 *   node scripts/prisma-engine-pin.mjs --schema-engine <path> --query-engine-library <path>
 *        [--prisma <path to prisma/build/index.js>] [--json]
 *
 * The paths may also come from PRISMA_SCHEMA_ENGINE_BINARY and
 * PRISMA_QUERY_ENGINE_LIBRARY, which is how the real CLI is pointed at them.
 *
 * Exit codes: 0 verified, 1 verification failed, 2 nothing to verify / bad usage.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import {
  PINNED_ARTIFACTS,
  PINNED_ENGINE_COMMIT,
  PINNED_PLATFORM,
  PINNED_PRISMA_VERSION,
  parseEngineCommit,
  verifyPinnedArtifact,
} from "./prisma-engine-pins.mjs";

const USAGE = `Usage: node scripts/prisma-engine-pin.mjs [options]

Verifies that the supplied Prisma engine artifacts are the official 5.17.0
release: SHA-256 against the published digests, and the commit reported by
\`schema-engine --version\`. Nothing is downloaded and no migration is run.

Options:
  --schema-engine <path>         schema-engine binary
                                 (default: $PRISMA_SCHEMA_ENGINE_BINARY)
  --query-engine-library <path>  libquery_engine.so.node
                                 (default: $PRISMA_QUERY_ENGINE_LIBRARY)
  --prisma <path>                prisma/build/index.js; when given, runs
                                 \`node <path> -v\` with the two variables set and
                                 checks it reports ${PINNED_PRISMA_VERSION} and the
                                 pinned commit
  --json                         Print the report as JSON
  --help, -h                     Show this text

Pinned release:
  prisma ${PINNED_PRISMA_VERSION}, engine commit ${PINNED_ENGINE_COMMIT},
  platform ${PINNED_PLATFORM}.

Obtaining the artifacts is described in docs/migration-strategy.md §7.1.2.
`;

function parseArgs(argv) {
  const options = { schemaEngine: undefined, queryEngineLibrary: undefined, prisma: undefined, json: false, help: false };
  const takeValue = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--schema-engine":
        options.schemaEngine = takeValue(arg, i++);
        break;
      case "--query-engine-library":
        options.queryEngineLibrary = takeValue(arg, i++);
        break;
      case "--prisma":
        options.prisma = takeValue(arg, i++);
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option '${arg}'.`);
    }
  }
  return options;
}

/** `schema-engine --version` output, or the reason it could not be read. */
function engineVersion(schemaEnginePath) {
  const result = spawnSync(schemaEnginePath, ["--version"], { encoding: "utf8", timeout: 30000 });
  if (result.error) return { ok: false, output: null, problem: `Could not run ${schemaEnginePath}: ${result.error.message}` };
  if (result.status !== 0) {
    return {
      ok: false,
      output: null,
      problem: `${schemaEnginePath} --version exited with status ${result.status}: ${(result.stderr || "").trim().slice(0, 200)}`,
    };
  }
  return { ok: true, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(), problem: null };
}

/** Ask the real CLI which engines it would use. */
function cliVersion(cliPath, env) {
  const result = spawnSync(process.execPath, [cliPath, "-v"], { encoding: "utf8", timeout: 60000, env });
  if (result.error) return { ok: false, output: null, problem: `Could not run '${cliPath} -v': ${result.error.message}` };
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0) {
    return { ok: false, output, problem: `'${cliPath} -v' exited with status ${result.status}: ${output.slice(0, 300)}` };
  }
  return { ok: true, output, problem: null };
}

function printHumanReport(report) {
  const lines = [];
  lines.push("");
  lines.push(`Pinned Prisma engine verification (prisma ${PINNED_PRISMA_VERSION}, commit ${PINNED_ENGINE_COMMIT.slice(0, 12)}…)`);
  lines.push("--------------------------------------------------------------------------------");
  for (const check of report.artifacts) {
    const label = check.artifact.padEnd(24);
    if (check.digest) {
      lines.push(`${label}: ${check.ok ? "MATCH" : "MISMATCH"}  sha256 ${check.digest}`);
      lines.push(`${"".padEnd(24)}  expected ${check.expected}`);
    } else {
      lines.push(`${label}: ${check.problems.join("; ")}`);
    }
    for (const problem of check.problems) lines.push(`  ! ${problem}`);
  }
  if (report.version) {
    lines.push("");
    lines.push(
      `schema-engine --version : ${
        report.version.ok ? report.version.output.split("\n")[0] : report.version.skipped ? "not run (digest did not match)" : "failed"
      }`
    );
  }
  if (report.cli) {
    lines.push("");
    lines.push(`prisma -v                : ${report.cli.ok ? "reports the pinned version and commit" : "FAILED"}`);
    if (report.cli.problem) lines.push(`  ! ${report.cli.problem}`);
  }
  lines.push("");
  lines.push(report.ok ? "Result: PASS — the supplied artifacts are the pinned 5.17.0 release." : "Result: FAIL. See the problems above.");
  if (report.ok) {
    lines.push("Next: run §4.2–4.6 of docs/migration-strategy.md against a restored copy");
    lines.push("(npm run migration:restore-rehearsal --keep) with these two variables exported.");
  }
  return lines.join("\n");
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const supplied = {
    schemaEngine: options.schemaEngine || process.env.PRISMA_SCHEMA_ENGINE_BINARY || null,
    queryEngineLibrary: options.queryEngineLibrary || process.env.PRISMA_QUERY_ENGINE_LIBRARY || null,
  };

  if (!supplied.schemaEngine && !supplied.queryEngineLibrary) {
    process.stderr.write(
      "Nothing to verify: no engine artifacts were supplied.\n" +
        "Pass --schema-engine and --query-engine-library (or set PRISMA_SCHEMA_ENGINE_BINARY and " +
        "PRISMA_QUERY_ENGINE_LIBRARY).\n\n" +
        `The pinned release is prisma ${PINNED_PRISMA_VERSION}, commit ${PINNED_ENGINE_COMMIT}, ` +
        `platform ${PINNED_PLATFORM}.\n` +
        "Artifacts come from binaries.prisma.sh; docs/migration-strategy.md §7.1.2 lists the exact " +
        "files, digests and commands.\n"
    );
    return 2;
  }

  const artifacts = [];
  for (const [key, artifact] of Object.entries(PINNED_ARTIFACTS)) {
    if (!supplied[key]) continue;
    artifacts.push(verifyPinnedArtifact({ path: supplied[key], artifact }));
  }

  const problems = [];

  // The digest check proves the bytes; the version check proves the binary agrees
  // about which commit it came from. Both are needed: a corrupted-but-lucky file
  // is impossible, but a file copied under the wrong name is not.
  let version = null;
  if (supplied.schemaEngine) {
    const schemaCheck = artifacts.find((check) => check.artifact === PINNED_ARTIFACTS.schemaEngine.artifact);
    if (!schemaCheck?.ok) {
      // Never execute a binary that failed the digest check: running it is the
      // risk the digest check exists to avoid.
      version = { ok: false, output: null, skipped: true };
    } else {
      const run = engineVersion(supplied.schemaEngine);
      if (!run.ok) {
        version = { ok: false, output: null };
        problems.push(run.problem);
      } else {
        const commit = parseEngineCommit(run.output);
        if (!commit) {
          version = { ok: false, output: run.output };
          problems.push(`schema-engine --version did not name a commit: ${run.output.slice(0, 200)}`);
        } else if (commit !== PINNED_ENGINE_COMMIT) {
          version = { ok: false, output: run.output };
          problems.push(
            `schema-engine reports commit ${commit}, but the pin is ${PINNED_ENGINE_COMMIT}. ` +
              "A build from another commit is not the release production runs."
          );
        } else {
          version = { ok: true, output: run.output };
        }
      }
    }
  }

  let cli = null;
  if (options.prisma) {
    if (!existsSync(options.prisma)) {
      cli = { ok: false, problem: `No such prisma CLI entry: ${options.prisma}` };
    } else if (!supplied.schemaEngine) {
      cli = { ok: false, problem: "--prisma needs --schema-engine, so the CLI can be pointed at the pinned engine." };
    } else {
      const env = {
        ...process.env,
        PRISMA_SCHEMA_ENGINE_BINARY: supplied.schemaEngine,
        ...(supplied.queryEngineLibrary ? { PRISMA_QUERY_ENGINE_LIBRARY: supplied.queryEngineLibrary } : {}),
      };
      const run = cliVersion(options.prisma, env);
      if (!run.ok) {
        cli = { ok: false, problem: run.problem };
      } else {
        const versionLine = run.output.split("\n").find((line) => /^prisma\s*:/.test(line)) ?? "";
        const cliProblems = [];
        if (!versionLine.includes(PINNED_PRISMA_VERSION)) {
          cliProblems.push(`CLI did not report prisma ${PINNED_PRISMA_VERSION}: ${versionLine || "no version line"}`);
        }
        // `prisma -v` prints several engine hashes; the pinned commit has to be
        // among them rather than being the first 40-hex string printed.
        if (!run.output.includes(PINNED_ENGINE_COMMIT)) {
          cliProblems.push(`CLI output does not mention engine commit ${PINNED_ENGINE_COMMIT}`);
        }
        cli = { ok: cliProblems.length === 0, output: run.output, problems: cliProblems };
      }
    }
    if (!cli.ok) problems.push(cli.problem ?? cli.problems.join("; "));
  }

  for (const check of artifacts) problems.push(...check.problems);

  const report = {
    pin: { prismaVersion: PINNED_PRISMA_VERSION, engineCommit: PINNED_ENGINE_COMMIT, platform: PINNED_PLATFORM },
    artifacts,
    version,
    cli,
    problems,
    ok: problems.length === 0,
  };

  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : printHumanReport(report)}\n`);
  return report.ok ? 0 : 1;
}

process.exitCode = main();
