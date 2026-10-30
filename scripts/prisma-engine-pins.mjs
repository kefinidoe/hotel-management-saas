/**
 * The identity of the Prisma engine release this application is pinned to.
 *
 * These are the only values that decide whether a supplied `schema-engine` /
 * `libquery_engine.so.node` pair is *the* engine that production will run. They
 * are recorded here — in code, with tests — rather than in prose, because
 * "obtained the right binaries" is a claim that has to be checkable by a
 * command, not by reading a document.
 *
 * Where the numbers come from
 * ---------------------------
 * `PINNED_ENGINE_COMMIT` is the commit `@prisma/engines@5.17.0` resolves to, as
 * recorded in this repository's `package-lock.json`.
 *
 * The digests are the official `.sha256` sidecars that `binaries.prisma.sh`
 * publishes next to each artifact. They were captured from the CDN's own sidecar
 * responses during a mirror probe (see `docs/migration-strategy.md` §7.1.1) and
 * then confirmed independently against `Jolg42/prisma-engines-artifacts`, a
 * public archive of Prisma's published checksums that keeps the same
 * `all_commits/<commit>/<platform>/<artifact>.sha256` layout:
 *
 *   schema-engine.sha256               0a52943c…  (archive agrees)
 *   schema-engine.gz.sha256            98ad433f…  (archive agrees)
 *   libquery_engine.so.node.sha256     077e8682…  (archive — the live capture
 *                                                  answered 404 before this one)
 *   libquery_engine.so.node.gz.sha256  125d7573…  (archive agrees)
 *
 * Confirming a digest against an archive is not the same as having the binary:
 * these digests let a supplied file be *rejected* if it is not the official
 * artifact, which is exactly the failure mode worth guarding against (a locally
 * built or redistributed engine, or one from another commit).
 *
 * Plain `.mjs` on purpose: the maintenance scripts run under plain Node.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

export const PINNED_PRISMA_VERSION = "5.17.0";

/** `@prisma/engines@5.17.0`, from package-lock.json. */
export const PINNED_ENGINE_COMMIT = "393aa359c9ad4a4bb28630fb5613f9c281cde053";

/** Platform this application deploys to (Debian/Ubuntu, OpenSSL 3.x). */
export const PINNED_PLATFORM = "debian-openssl-3.0.x";

/**
 * The two artifacts the pinned CLI needs: `schema-engine` runs migrations, and
 * `libquery_engine.so.node` runs the client's queries.
 */
export const PINNED_ARTIFACTS = {
  schemaEngine: {
    artifact: "schema-engine",
    archive: "schema-engine.gz",
    sha256: "0a52943c68c41f28d00359001b6f271df7c0ad9a68aa32be2570f80594db956e",
    archiveSha256: "98ad433fd64da2ea1eb6d565553a9a4339ecf30f1c211b28b69690f591269a41",
    envVar: "PRISMA_SCHEMA_ENGINE_BINARY",
    executable: true,
  },
  queryEngineLibrary: {
    artifact: "libquery_engine.so.node",
    archive: "libquery_engine.so.node.gz",
    sha256: "077e86821d96c3225ec75c4e2172822f8969cd4f720942f944bc853ea1b77f9f",
    archiveSha256: "125d75739bd7fcdb8eabb5428355b5be00f540043e6bc1f5b30268947afab1bd",
    envVar: "PRISMA_QUERY_ENGINE_LIBRARY",
    executable: false,
  },
};

/** SHA-256 of a file's bytes. Reads the file once; engines are ~15-45 MB. */
export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Extract the 40-hex engine commit from something like
 * `schema-engine-cli 393aa359c9ad4a4bb28630fb5613f9c281cde053`.
 *
 * Returns null when the output carries no commit — which is itself a finding: an
 * engine that will not state its commit cannot be tied to the pin.
 */
export function parseEngineCommit(output) {
  const match = String(output).match(/\b[0-9a-f]{40}\b/);
  return match ? match[0] : null;
}

/**
 * Check one supplied artifact against the pin.
 *
 * Takes the artifact descriptor rather than reading PINNED_ARTIFACTS directly,
 * so the matching, mismatch and missing-file paths can be tested without a
 * 40 MB engine.
 *
 * `path` is null when the caller supplied no artifact at all, which is a
 * distinct failure from supplying one that does not exist.
 *
 * @param {{ path?: string | null, artifact: { artifact: string, sha256: string, envVar: string } }} params
 * @returns {{ ok: boolean, artifact: string, path: string | null, digest: string | null, expected: string, size: number | null, problems: string[] }}
 */
export function verifyPinnedArtifact({ path: filePath, artifact }) {
  const expected = artifact.sha256;
  const name = artifact.artifact;
  const problems = [];

  if (!filePath) {
    return {
      ok: false,
      artifact: name,
      path: null,
      digest: null,
      expected,
      size: null,
      problems: [`No ${name} supplied (expected via --${name === "schema-engine" ? "schema-engine" : "query-engine-library"} or ${artifact.envVar}).`],
    };
  }

  if (!existsSync(filePath)) {
    return { ok: false, artifact: name, path: filePath, digest: null, expected, size: null, problems: [`No such file: ${filePath}`] };
  }

  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size === 0) {
    return { ok: false, artifact: name, path: filePath, digest: null, expected, size: stats.size, problems: [`${filePath} is not a non-empty file.`] };
  }

  const digest = sha256File(filePath);
  if (digest !== expected) {
    problems.push(
      `${name} does not match the pinned 5.17.0 artifact: sha256 ${digest}, expected ${expected}. ` +
        "Do not run this engine; obtain the official artifact (docs/migration-strategy.md §7.1.2)."
    );
  }

  return { ok: problems.length === 0, artifact: name, path: filePath, digest, expected, size: stats.size, problems };
}
