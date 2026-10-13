/**
 * Canonical comparison of two reads of the same Stream configuration document.
 */

export function compareStringsByCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function byCodeUnit(
  [a]: [string, unknown],
  [b]: [string, unknown],
): number {
  return compareStringsByCodeUnit(a, b);
}

/** Server-managed metadata re-stamped by Stream on any write. */
const SERVER_STAMPED_KEYS = new Set(["updated_at"]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(normalize)
      .toSorted((a, b) =>
        compareStringsByCodeUnit(JSON.stringify(a), JSON.stringify(b)),
      );
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SERVER_STAMPED_KEYS.has(key))
      .map(([key, val]) => [key, normalize(val)] as [string, unknown])
      .toSorted(byCodeUnit),
  );
}

/** Order-insensitive, metadata-free JSON representation for drift checks. */
export function canonical(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/** Returns field names that differ between two fingerprint snapshots. */
export function diffFingerprints(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  return Object.keys(before).filter((key) => before[key] !== after[key]);
}
