/**
 * Canonical comparison of two reads of the same Stream configuration document.
 *
 * Three scripts write config to Stream and each has to answer the same
 * question afterwards: did this write change something it was not given?
 * `updateCallType` and `updateApp` both take partials, neither documents
 * whether the omitted fields survive, and the chat twin `channel.update()` is a
 * full replace — so each one snapshots, writes, re-reads and compares.
 *
 * That comparison lived in three places. `ensure-call-type-grants.ts` and
 * `ensure-call-type-settings.ts` had two implementations of the same idea, and
 * `ensure-app-settings.ts` made a third. They must agree: this is the check that
 * decides whether an operator is told their webhook subscription was just
 * destroyed, and three copies of it is three chances for one to drift into a
 * false negative on the run where it matters.
 */

/**
 * Code-unit ordering, never `localeCompare`.
 *
 * The same rule as the channel ids, for the same reason: ICU collation is
 * locale- and environment-dependent, so a comparison built on it can answer
 * differently in CI and on a laptop. Here that would mean an identical config
 * reporting as drift — telling an operator, mid-incident, that Stream had
 * discarded settings it never touched.
 */
export function byCodeUnit(
  [a]: [string, unknown],
  [b]: [string, unknown],
): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Stable stringify, so two independent reads of an UNCHANGED document compare
 * equal.
 *
 * Plain `JSON.stringify` preserves key insertion order, and the two snapshots
 * come from two separate HTTP responses. Nothing guarantees those arrive in the
 * same order, so without this a false positive is a matter of luck.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (!val || typeof val !== "object" || Array.isArray(val)) return val;
    const entries = Object.entries(val as Record<string, unknown>);
    return Object.fromEntries(entries.toSorted(byCodeUnit));
  });
}

/**
 * Which of `fields` differ between two reads.
 *
 * Returns names rather than a boolean because the names are the actionable
 * part: "event_hooks changed" tells an operator the webhook pipeline is down,
 * where "something changed" tells them to go looking.
 */
export function diffFingerprints(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  return Object.keys(before).filter((key) => before[key] !== after[key]);
}
