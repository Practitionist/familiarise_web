/**
 * @jest-environment node
 */

/**
 * #1780 E-1 — a learner may leave a class series with every undelivered
 * session refunded once the host has cancelled three sessions or a quarter
 * of the series, whichever comes first.
 */

import { exitRightFor, seriesLedgerFrom } from "@/lib/booking/class-series";

it("3 misses of 12 → exit right; 2 of 12 → none; 2 of 8 (25 %) → exit right", () => {
  expect(exitRightFor(3, 12)).toBe(true);
  expect(exitRightFor(2, 12)).toBe(false);
  expect(exitRightFor(2, 8)).toBe(true);
});

it("#1569 D6 — two cancels plus one void give the exit right; a platform void does not count toward the flag", () => {
  const day = (d: number) => new Date(Date.UTC(2026, 8, d, 10));
  const row = (d: number, extra: object) => ({
    ordinal: d,
    startsAt: day(d),
    endsAt: day(d),
    completionStatus: "CANCELLED" as const,
    movedAt: null,
    ...extra,
  });
  const ledger = seriesLedgerFrom({
    N: 12,
    now: day(20),
    occurrences: [
      row(1, { hostCancelledAt: day(1) }),
      row(2, { hostCancelledAt: day(2) }),
      row(3, {
        completionStatus: "VOIDED",
        voidedAt: day(3),
        outcome: "PLATFORM_OUTAGE",
      }),
    ],
  });
  expect(ledger).toMatchObject({ misses: 3, hostMisses: 2, exitRight: true });
  expect(exitRightFor(ledger.hostMisses, ledger.N)).toBe(false);
});
