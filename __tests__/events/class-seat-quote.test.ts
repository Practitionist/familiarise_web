/**
 * @jest-environment node
 */

/**
 * #1780 D-4 — leaving a class series mid-way refunds each remaining session at
 * its own notice tier out of one per-seat unit; each seat has its own ledger.
 */

import { seatLedgerFrom } from "@/lib/booking/class-series";
import { quoteClassSeatRefund } from "@/lib/payments/operations/cancellation-policy";

const NOW = new Date("2026-10-01T12:00:00Z");
const H = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * H);
/** Eight weekly sessions; the first `delivered` already happened. */
const series = (delivered: number, firstAheadHours: number) =>
  Array.from({ length: 8 }, (_, i) => {
    const startsAt =
      i < delivered
        ? at(-24 * 7 * (delivered - i))
        : at(firstAheadHours + 24 * 7 * (i - delivered));
    return {
      ordinal: i + 1,
      startsAt,
      endsAt: new Date(startsAt.getTime() + H),
      completionStatus: (i < delivered ? "COMPLETED" : "SCHEDULED") as
        | "COMPLETED"
        | "SCHEDULED",
      movedAt: null,
    };
  });
const ledgerFor = (joinedAt: Date, firstAheadHours: number) =>
  seatLedgerFrom({
    N: 8,
    amountPaise: 80_000,
    joinedAt,
    occurrences: series(3, firstAheadHours),
    now: NOW,
  });
// A ladder where one hour's notice is the 50 % rung.
const policy = {
  policyId: null,
  source: "PLATFORM" as const,
  version: 1,
  tiers: [
    { hoursBefore: 24, refundPct: 100 },
    { hoursBefore: 0, refundPct: 50 },
  ],
  consultantInitiatedPct: 100,
};
const quote = (ledger: ReturnType<typeof ledgerFor>) =>
  quoteClassSeatRefund({
    policy,
    isConsultantInitiated: false,
    unitPaise: ledger.unitPaise,
    remainingStartsMs: ledger.remaining.map((r) => r.startsAt.getTime()),
    neverScheduled: ledger.neverScheduled,
    refundablePaise: 80_000,
    nowMs: NOW.getTime(),
  }).refundPaise;

it("N = 8, 3 delivered: next in 30 h → 5 units; next in 1 h → 4 units + 50 %", () => {
  const early = ledgerFor(at(-24 * 60), 30);
  expect(early.unitPaise).toBe(BigInt(10_000));
  expect(quote(early)).toBe(50_000);
  expect(quote(ledgerFor(at(-24 * 60), 1))).toBe(45_000);
});

it("a mid-series joiner who bought after 4 of 8 started holds 4", () => {
  const joiner = seatLedgerFrom({
    N: 8,
    amountPaise: 40_000,
    joinedAt: at(-1),
    occurrences: series(4, 30),
    now: NOW,
  });
  expect(joiner.heldCount).toBe(4);
  expect(joiner.deliveredHeld).toBe(0);
  expect(joiner.unitPaise).toBe(BigInt(10_000));
});

it("three seats leaving at different times each get their own quote", () => {
  const seats = [at(-24 * 60), at(-24 * 16), at(-1)].map((joinedAt) =>
    seatLedgerFrom({
      N: 8,
      amountPaise: 80_000,
      joinedAt,
      occurrences: series(3, 30),
      now: NOW,
    }),
  );
  expect(seats.map((s) => s.heldCount)).toEqual([8, 7, 5]);
  expect(seats.map(quote)).toEqual([50_000, 57_140, 80_000]);
});

it("a session the seat already took back (skip, occ:*) leaves the exit quote (#1780 E-3b)", () => {
  const ledger = ledgerFor(at(-24 * 60), 30);
  const exit = (alreadyRefundedPaise: number) =>
    quoteClassSeatRefund({
      policy,
      isConsultantInitiated: true,
      unitPaise: ledger.unitPaise,
      remainingStartsMs: ledger.remaining.map((r) => r.startsAt.getTime()),
      neverScheduled: ledger.neverScheduled,
      alreadyRefundedPaise,
      refundablePaise: 80_000,
      nowMs: NOW.getTime(),
    }).refundPaise;
  expect(exit(0)).toBe(50_000);
  expect(exit(10_000)).toBe(40_000);
});
