/**
 * #1780 — the class-series ledger: what one seat bought, what it has been
 * delivered, and what a session of it is worth. One helper, so the seat-leave
 * quote, the series cancel, the make-up sweep and the skip route can never
 * disagree about a unit.
 *
 * Definitions (decision 10):
 *   - N is ClassPlan.totalSessions.
 *   - A seat "holds" a session that starts after the seat was created, so a
 *     mid-series joiner never pays for, or is refunded for, sessions before it.
 *   - heldCount = the seat's stored sessionsPurchased (#1819); on a legacy
 *     seat, the held sessions delivered or still live, by distinct ordinal,
 *     capped at N, with zero falling back to N.
 *   - unit = floor(seat amount / heldCount), in BigInt; rounding favours the
 *     buyer on every series-level amount (amount − unit × delivered).
 *   - delivered = endsAt ≤ now and not CANCELLED/RESCHEDULED/VOIDED; remaining =
 *     live SCHEDULED rows starting after now; neverScheduled is the rest.
 */

import type {
  OccurrenceCompletionStatus,
  OccurrenceOutcome,
} from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { HOST_ATTRIBUTED_OUTCOMES } from "./session-outcome";

export interface LedgerOccurrence {
  ordinal: number;
  startsAt: Date;
  endsAt: Date;
  completionStatus: OccurrenceCompletionStatus;
  movedAt: Date | null;
  /** #1780 row 4 — a session the host cancelled; still counts toward N. */
  hostCancelledAt?: Date | null;
  /** #1569 — a held session voided by the outcome sweep; a miss like a cancel. */
  voidedAt?: Date | null;
  outcome?: OccurrenceOutcome | null;
}

/** #1569 — host-cancelled or voided: owed a make-up or a refund, never delivered. */
const isMissed = (o: LedgerOccurrence) => !!(o.hostCancelledAt ?? o.voidedAt);

/** D6 — a miss the host answers for: every host cancel, and CUT_SHORT/HOST_ABSENT voids. */
const isHostMiss = (o: LedgerOccurrence) =>
  !!o.hostCancelledAt ||
  (!!o.voidedAt && !!o.outcome && HOST_ATTRIBUTED_OUTCOMES.includes(o.outcome));

export interface SeatLedger {
  N: number;
  heldCount: number;
  unitPaise: bigint;
  deliveredHeld: number;
  /** Live sessions the seat holds that have not started, earliest first. */
  remaining: { startsAt: Date; movedAt: Date | null }[];
  neverScheduled: number;
}

const DEAD = new Set<OccurrenceCompletionStatus>([
  "CANCELLED",
  "RESCHEDULED",
  "VOIDED",
]);

const isDelivered = (o: LedgerOccurrence, now: Date) =>
  o.endsAt <= now && !DEAD.has(o.completionStatus);

const isLiveAhead = (o: LedgerOccurrence, now: Date) =>
  o.completionStatus === "SCHEDULED" && o.startsAt > now;

/** The ledger for one seat, from its sessions. Pure. */
export function seatLedgerFrom(args: {
  N: number;
  amountPaise: bigint | number;
  joinedAt: Date;
  occurrences: LedgerOccurrence[];
  now: Date;
  /** #1819 — the stored fact; null on a legacy seat, which falls back to the derivation. */
  sessionsPurchased?: number | null;
}): SeatLedger {
  const { N, joinedAt, now } = args;
  const held = args.occurrences.filter((o) => o.startsAt > joinedAt);
  const delivered = held.filter((o) => isDelivered(o, now));
  const remaining = held
    .filter((o) => isLiveAhead(o, now))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  // A missed session (host-cancelled or voided) keeps its place in the seat's
  // count (E-2): it is made up or refunded one unit, so the unit must not move.
  const missed = held.filter(isMissed);
  const ordinals = new Set(
    [...delivered, ...remaining, ...missed].map((o) => o.ordinal),
  );
  const heldCount = args.sessionsPurchased || Math.min(N, ordinals.size) || N;
  const deliveredHeld = Math.min(delivered.length, heldCount);
  return {
    N,
    heldCount,
    unitPaise: BigInt(args.amountPaise) / BigInt(Math.max(heldCount, 1)),
    deliveredHeld,
    remaining: remaining.map((o) => ({
      startsAt: o.startsAt,
      movedAt: o.movedAt,
    })),
    neverScheduled: Math.max(0, heldCount - deliveredHeld - remaining.length),
  };
}

/** A seat's ledger plus what it already got back per session (D-5). */
export type SeriesSeat = SeatLedger & { occRefundedPaise?: number };

/** What a host cancelling the whole series refunds this seat (D-5). */
export function seriesCancelRefundPaise(
  ledger: SeatLedger,
  amountPaise: bigint | number,
): bigint {
  const left =
    BigInt(amountPaise) - ledger.unitPaise * BigInt(ledger.deliveredHeld);
  return left > BigInt(0) ? left : BigInt(0);
}

const LEDGER_OCCURRENCE_SELECT = {
  ordinal: true,
  startsAt: true,
  endsAt: true,
  completionStatus: true,
  movedAt: true,
  hostCancelledAt: true,
  voidedAt: true,
  outcome: true,
} as const;

/** Reads the seat's sessions and its plan size, on the caller's client. */
export async function seatLedger(
  db: Pick<Tx, "appointment" | "appointmentOccurrence">,
  seat: {
    appointmentId: string;
    createdAt: Date;
    sessionsPurchased?: number | null;
  },
  amountPaise: bigint | number,
  now = new Date(),
): Promise<SeatLedger> {
  // Sequential: the caller's transaction runs one statement at a time.
  const appointment = await db.appointment.findUnique({
    where: { id: seat.appointmentId },
    select: {
      class: { select: { classPlan: { select: { totalSessions: true } } } },
    },
  });
  const occurrences = await db.appointmentOccurrence.findMany({
    where: {
      appointmentId: seat.appointmentId,
      deletedAt: null,
      isTentative: false,
    },
    select: LEDGER_OCCURRENCE_SELECT,
  });
  return seatLedgerFrom({
    N: appointment?.class?.classPlan?.totalSessions ?? occurrences.length,
    amountPaise,
    joinedAt: seat.createdAt,
    occurrences,
    now,
    sessionsPurchased: seat.sessionsPurchased,
  });
}

/** #1780 decision 9 — the times a freed ordinal held before a re-plan. */
export type FreedWindow = { ordinal: number; startsAt: Date; endsAt: Date };

/**
 * A replacement row is a host move when the reschedule path wrote it, or when
 * its times differ from the freed row of the same ordinal; identical times
 * are not a move (never inferred from createdAt).
 */
export function isHostMove(
  row: { ordinal: number; startsAt: Date; endsAt: Date },
  moves: { isReschedule: boolean; freedWindows: FreedWindow[] },
): boolean {
  if (moves.isReschedule) return true;
  const prior = moves.freedWindows.find((w) => w.ordinal === row.ordinal);
  return (
    !!prior &&
    (prior.startsAt.getTime() !== row.startsAt.getTime() ||
      prior.endsAt.getTime() !== row.endsAt.getTime())
  );
}

/** #1780 E-1 — the series as a whole: what it delivered, owes and missed. */
export interface SeriesLedger {
  N: number;
  delivered: number;
  remaining: number;
  neverScheduled: number;
  /** Sessions missed, made up or not: host cancellations and voids (#1569). */
  misses: number;
  /** D6 — the misses the host answers for; these alone feed the reliability flag. */
  hostMisses: number;
  /** The learner may leave with every undelivered session refunded (E-5). */
  exitRight: boolean;
}

/** Three misses, or a quarter of the series, gives the learner an exit right. */
export const exitRightFor = (misses: number, N: number): boolean =>
  misses > 0 && (misses >= 3 || 4 * misses >= N);

/** Pure: the series ledger from its sessions. */
export function seriesLedgerFrom(args: {
  N: number;
  occurrences: LedgerOccurrence[];
  now: Date;
}): SeriesLedger {
  const { N, now } = args;
  const delivered = args.occurrences.filter((o) => isDelivered(o, now)).length;
  const remaining = args.occurrences.filter((o) => isLiveAhead(o, now)).length;
  const misses = args.occurrences.filter(isMissed).length;
  return {
    N,
    delivered,
    remaining,
    neverScheduled: Math.max(0, N - delivered - remaining),
    misses,
    hostMisses: args.occurrences.filter(isHostMiss).length,
    exitRight: exitRightFor(misses, N),
  };
}

/** Reads the class wrapper's sessions and plan size on the caller's client. */
export async function seriesLedger(
  db: Pick<Tx, "appointment" | "appointmentOccurrence">,
  appointmentId: string,
  now = new Date(),
): Promise<SeriesLedger> {
  const appointment = await db.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      class: { select: { classPlan: { select: { totalSessions: true } } } },
    },
  });
  const occurrences = await db.appointmentOccurrence.findMany({
    where: { appointmentId, deletedAt: null, isTentative: false },
    select: LEDGER_OCCURRENCE_SELECT,
  });
  return seriesLedgerFrom({
    N: appointment?.class?.classPlan?.totalSessions ?? occurrences.length,
    occurrences,
    now,
  });
}

/** #1780 E-3b — units this payment already got back per session (`occ:*`). */
export async function occurrenceRefundsPaise(
  db: Pick<Tx, "refund">,
  paymentId: string,
): Promise<number> {
  const rows = await db.refund.findMany({
    where: {
      paymentId,
      status: { in: ["SUCCEEDED", "PENDING"] },
      dedupeKey: { startsWith: "occ:", endsWith: `:pay:${paymentId}` },
    },
    select: { amountPaise: true },
  });
  return rows.reduce((sum, r) => sum + Number(r.amountPaise), 0);
}
