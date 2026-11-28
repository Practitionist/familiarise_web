/**
 * @jest-environment node
 */

/**
 * The class exit right: a learner may leave with every undelivered session
 * refunded after 3 host misses inside any rolling 30 days, or once total
 * misses reach max(3, ceil(15 % of N)).
 */

import {
  exitRightFor,
  exitThresholdFor,
  reliabilityThresholdMet,
  seriesLedgerFrom,
} from "@/lib/booking/class-series";

const day = (d: number) => new Date(Date.UTC(2026, 8, 1, 10) + d * 86_400_000);

describe("exitThresholdFor", () => {
  it.each([
    [4, 3],
    [8, 3],
    [12, 3],
    [20, 3],
    [21, 4],
    [40, 6],
    [100, 15],
    [101, 16],
  ])("N = %i → %i misses", (N, threshold) => {
    expect(exitThresholdFor(N)).toBe(threshold);
  });
});

describe("exitRightFor", () => {
  const spread = (days: number[]) => days.map(day);

  it("12 sessions: 3 misses in all trip it, 2 do not", () => {
    expect(exitRightFor({ hostMissAts: [], misses: 3, N: 12 })).toBe(true);
    expect(exitRightFor({ hostMissAts: [], misses: 2, N: 12 })).toBe(false);
  });

  it("8 sessions: 2 misses no longer trip it (the old quarter rule)", () => {
    expect(exitRightFor({ hostMissAts: [], misses: 2, N: 8 })).toBe(false);
  });

  it("100 sessions: 15 misses in all trip it, 14 spread out do not", () => {
    const monthly = spread([0, 31, 62, 93, 124, 155, 186, 217, 248, 279]);
    expect(exitRightFor({ hostMissAts: monthly, misses: 14, N: 100 })).toBe(
      false,
    );
    expect(exitRightFor({ hostMissAts: monthly, misses: 15, N: 100 })).toBe(
      true,
    );
  });

  it("100 sessions: 3 host misses inside 30 days trip it", () => {
    const ats = spread([0, 14, 29]);
    expect(exitRightFor({ hostMissAts: ats, misses: 3, N: 100 })).toBe(true);
  });

  it("100 sessions: 3 host misses spread over 60 days do not", () => {
    const ats = spread([0, 30, 60]);
    expect(exitRightFor({ hostMissAts: ats, misses: 3, N: 100 })).toBe(false);
  });

  it("any window counts, not only the last 30 days, so the right does not lapse with time", () => {
    // A tight cluster early in the class, then a long quiet stretch.
    const ats = spread([0, 5, 10, 90, 180]);
    expect(exitRightFor({ hostMissAts: ats, misses: 5, N: 100 })).toBe(true);
  });

  it("the window is strict: a 30-day spread less a millisecond trips, exactly 30 days does not", () => {
    const at = (ms: number) => new Date(day(0).getTime() + ms);
    const window = 30 * 86_400_000;
    expect(
      exitRightFor({
        hostMissAts: [at(0), at(window / 2), at(window - 1)],
        misses: 3,
        N: 100,
      }),
    ).toBe(true);
    expect(
      exitRightFor({
        hostMissAts: [at(0), at(window / 2), at(window)],
        misses: 3,
        N: 100,
      }),
    ).toBe(false);
  });

  it("order does not matter", () => {
    const ats = spread([29, 0, 14]);
    expect(exitRightFor({ hostMissAts: ats, misses: 3, N: 100 })).toBe(true);
  });
});

describe("seriesLedgerFrom", () => {
  const row = (d: number, extra: object) => ({
    ordinal: d,
    startsAt: day(d),
    endsAt: day(d),
    completionStatus: "CANCELLED" as const,
    movedAt: null,
    ...extra,
  });

  it("two cancels plus a platform void give the exit right; the platform void does not count toward the flag", () => {
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
    expect(ledger).toMatchObject({
      misses: 3,
      hostMisses: 2,
      hostMissAts: [day(1), day(2)],
      exitThreshold: 3,
      exitRight: true,
    });
    expect(reliabilityThresholdMet(ledger)).toBe(false);
  });

  it("a confirmed host-absent and cut-short void count in the 30-day window by their void time", () => {
    const ledger = seriesLedgerFrom({
      N: 100,
      now: day(40),
      occurrences: [
        row(1, { hostCancelledAt: day(1) }),
        row(2, {
          completionStatus: "VOIDED",
          voidedAt: day(10),
          outcome: "HOST_ABSENT",
          outcomeConfirmedAt: day(12),
        }),
        row(3, {
          completionStatus: "VOIDED",
          voidedAt: day(20),
          outcome: "CUT_SHORT",
          outcomeConfirmedAt: day(22),
        }),
      ],
    });
    expect(ledger).toMatchObject({
      misses: 3,
      hostMisses: 3,
      exitThreshold: 15,
      exitRight: true,
    });
    expect(reliabilityThresholdMet(ledger)).toBe(true);
  });

  it("an unconfirmed host-attributed void is no miss yet; an unconfirmed outage void is", () => {
    const ledger = seriesLedgerFrom({
      N: 12,
      now: day(20),
      occurrences: [
        row(1, { hostCancelledAt: day(1) }),
        row(2, {
          completionStatus: "VOIDED",
          voidedAt: day(2),
          outcome: "HOST_ABSENT",
          outcomeConfirmedAt: null,
        }),
        row(3, {
          completionStatus: "VOIDED",
          voidedAt: day(3),
          outcome: "PLATFORM_OUTAGE",
          outcomeConfirmedAt: null,
        }),
      ],
    });
    expect(ledger).toMatchObject({
      misses: 2,
      hostMisses: 1,
      exitRight: false,
    });
  });

  it("100 sessions: 3 host misses a month apart give no exit right yet", () => {
    const ledger = seriesLedgerFrom({
      N: 100,
      now: day(70),
      occurrences: [
        row(1, { hostCancelledAt: day(1) }),
        row(2, { hostCancelledAt: day(31) }),
        row(3, { hostCancelledAt: day(61) }),
      ],
    });
    expect(ledger).toMatchObject({ misses: 3, exitRight: false });
  });
});
