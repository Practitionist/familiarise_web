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
 *   - heldCount = the held sessions that are delivered or still live, by
 *     distinct ordinal, capped at N; zero falls back to N.
 *   - unit = floor(seat amount / heldCount), in BigInt; rounding favours the
 *     buyer on every series-level amount (amount − unit × delivered).
 *   - delivered = endsAt ≤ now and not CANCELLED/RESCHEDULED; remaining =
 *     live SCHEDULED rows starting after now; neverScheduled is the rest.
 */

import type { OccurrenceCompletionStatus } from "@prisma/client";

import type { Tx } from "@/lib/prisma";

export interface LedgerOccurrence {
  ordinal: number;
  startsAt: Date;
  endsAt: Date;
  completionStatus: OccurrenceCompletionStatus;
  movedAt: Date | null;
  /** #1780 row 4 — a session the host cancelled; still counts toward N. */
  hostCancelledAt?: Date | null;
}

export interface SeatLedger {
  N: number;
  heldCount: number;
  unitPaise: bigint;
  deliveredHeld: number;
  /** Live sessions the seat holds that have not started, earliest first. */
  remaining: { startsAt: Date; movedAt: Date | null }[];
  neverScheduled: number;
}

const DEAD = new Set<OccurrenceCompletionStatus>(["CANCELLED", "RESCHEDULED"]);

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
}): SeatLedger {
  const { N, joinedAt, now } = args;
  const held = args.occurrences.filter((o) => o.startsAt > joinedAt);
  const delivered = held.filter((o) => isDelivered(o, now));
  const remaining = held
    .filter((o) => isLiveAhead(o, now))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  // A host-cancelled session keeps its place in the seat's count (E-2): it
  // is either made up or refunded one unit, so the unit must not move.
  const hostCancelled = held.filter((o) => o.hostCancelledAt);
  const ordinals = new Set(
    [...delivered, ...remaining, ...hostCancelled].map((o) => o.ordinal),
  );
  const heldCount = Math.min(N, ordinals.size) || N;
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
} as const;

/** Reads the seat's sessions and its plan size, on the caller's client. */
export async function seatLedger(
  db: Pick<Tx, "appointment" | "appointmentOccurrence">,
  seat: { appointmentId: string; createdAt: Date },
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
  /** Sessions the host cancelled, made up or not (misses = host cancellations). */
  misses: number;
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
  const misses = args.occurrences.filter((o) => o.hostCancelledAt).length;
  return {
    N,
    delivered,
    remaining,
    neverScheduled: Math.max(0, N - delivered - remaining),
    misses,
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
