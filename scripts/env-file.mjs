#!/usr/bin/env node
/**
 * The one `.env` reader for this repository.
 *
 * Why this exists
 * ---------------
 * `backup-db.mjs` and `restore-db.mjs` each carried a private copy of this
 * parser, `db:verify` had none at all (so it read only the shell environment),
 * the Next.js server gets `.env` from Next itself, and the Prisma CLI loads
 * `.env` on its own. Four different answers to "what is DATABASE_URL?" is how an
 * operator verifies one database and migrates another.
 *
 * Rules (deliberately the same as dotenv / the Prisma CLI):
 *  - a variable already present in `process.env` wins; `.env` never overrides it;
 *  - `KEY=value`, `export KEY=value`, `#` comments and blank lines are accepted;
 *  - single quotes are literal, double quotes honour `\n`, `\r`, `\t`, `\\` and `\"`;
 *  - an unquoted value loses a trailing ` # comment`;
 *  - CRLF files and a UTF-8 BOM are handled (this repository is edited on Windows).
 *
 * Precedence between files matches the Prisma CLI: a `.env` next to the schema
 * (`prisma/.env`) is applied before the project-root `.env`, and because nothing
 * overrides an already-set key, the schema-adjacent file wins. When both files
 * define the same key with different values, `loadEnvFiles` reports the conflict
 * by name so callers can warn without ever printing a value.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function unquote(raw) {
  const value = raw.trim();

  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  // Unquoted: drop a trailing inline comment, which is how dotenv behaves.
  return value.replace(/\s+#.*$/, "").trim();
}

/**
 * Parse the contents of a `.env` file.
 *
 * @param {string} contents
 * @returns {Record<string, string>}
 */
export function parseEnvFile(contents) {
  const result = {};
  const text = String(contents).replace(/^\uFEFF/, "");

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    result[match[1]] = unquote(match[2]);
  }

  return result;
}

/**
 * The files the Prisma CLI considers, in the order they are applied.
 *
 * @param {string} [rootDir]
 * @returns {string[]}
 */
export function resolveEnvFilePaths(rootDir = REPO_ROOT) {
  return [join(rootDir, "prisma", ".env"), join(rootDir, ".env")];
}

/**
 * Read every `.env` file that exists, without touching `process.env`.
 *
 * @param {{ rootDir?: string, files?: string[] }} [options]
 * @returns {{ values: Record<string, string>, files: string[], conflicts: string[] }}
 */
export function readEnvFiles({ rootDir = REPO_ROOT, files = resolveEnvFilePaths(rootDir) } = {}) {
  const values = {};
  const applied = [];
  const conflicts = [];
  const seenIn = new Map();

  for (const file of files) {
    if (!existsSync(file)) continue;
    const parsed = parseEnvFile(readFileSync(file, "utf8"));
    applied.push(file);

    for (const [key, value] of Object.entries(parsed)) {
      const previousFile = seenIn.get(key);
      if (previousFile !== undefined && values[key] !== value) {
        conflicts.push(key);
      }
      if (!(key in values)) {
        values[key] = value;
        seenIn.set(key, file);
      }
    }
  }

  return { values, files: applied, conflicts };
}

/**
 * Apply `.env` files to `process.env` without overriding existing variables,
 * exactly as the Prisma CLI and Next.js do.
 *
 * @param {{ rootDir?: string, files?: string[], override?: boolean, quiet?: boolean }} [options]
 * @returns {{ files: string[], keys: string[], conflicts: string[] }}
 */
export function loadEnvFiles({ rootDir = REPO_ROOT, files, override = false, quiet = false } = {}) {
  const { values, files: applied, conflicts } = readEnvFiles({ rootDir, files });

  for (const [key, value] of Object.entries(values)) {
    if (!override && process.env[key] !== undefined) continue;
    process.env[key] = value;
  }

  if (!quiet && conflicts.length > 0 && typeof process.stderr.write === "function") {
    process.stderr.write(
      `WARNING: ${conflicts.join(", ")} differ between .env files; ` +
        "the copy next to prisma/schema.prisma takes precedence.\n"
    );
  }

  return { files: applied, keys: Object.keys(values), conflicts };
}

/** A `.env`-first, shell-second view of the environment (shell wins). */
export function effectiveEnv() {
  return process.env;
}

export { unquote as parseEnvValue };
