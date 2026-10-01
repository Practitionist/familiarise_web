/**
 * #1780 R-2 — the availability editor sends back every custom window it read,
 * including ones that have since ended. An unchanged window that is already
 * past is history, not a new offer, so it is dropped from validation and the
 * write instead of failing the whole save with 400 PAST. A NEW window in the
 * past still reaches the validator and is still refused.
 */
export function dropUnchangedPastWindows<
  T extends { startsAt: Date; endsAt: Date },
>(
  incoming: readonly T[],
  existing: readonly { startsAt: Date; endsAt: Date }[],
  now = new Date(),
): T[] {
  const known = new Set(
    existing.map((w) => `${w.startsAt.getTime()}|${w.endsAt.getTime()}`),
  );
  return incoming.filter(
    (w) =>
      w.endsAt.getTime() > now.getTime() ||
      !known.has(`${w.startsAt.getTime()}|${w.endsAt.getTime()}`),
  );
}
