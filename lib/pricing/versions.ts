/**
 * Append-only pricing versions.
 *
 * A reservation's price is a ledger, not a column: version 1 is written when the
 * reservation is created, every repricing appends the next version, and nothing
 * ever rewrites an existing row. "The current price" therefore has exactly one
 * definition — the highest version for that reservation — which this module
 * keeps in one place so billing, repricing and the API cannot disagree.
 */

export type PriceVersion = { version: number };

/** Prisma include/orderBy fragment for "the newest version only". */
export const CURRENT_PRICE_VERSION_QUERY = {
  orderBy: { version: "desc" },
  take: 1,
} as const;

/** The current (highest) version from a list of versions, or null when none exists. */
export function currentPriceVersion<T extends PriceVersion>(
  versions: readonly T[] | null | undefined
): T | null {
  if (!versions || versions.length === 0) return null;
  return versions.reduce((latest, candidate) =>
    candidate.version > latest.version ? candidate : latest
  );
}

/** The version number a repricing should write next. */
export function nextPriceVersion(current: PriceVersion | null | undefined): number {
  return (current?.version ?? 0) + 1;
}

/**
 * Sort versions oldest-first for display/export. Returns a copy so callers never
 * mutate the rows they received.
 */
export function priceVersionHistory<T extends PriceVersion>(versions: readonly T[] | null | undefined): T[] {
  return [...(versions ?? [])].sort((left, right) => left.version - right.version);
}
