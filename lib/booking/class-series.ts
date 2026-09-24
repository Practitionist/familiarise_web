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
  const ordinals = new Set([...delivered, ...remaining].map((o) => o.ordinal));
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
    select: {
      ordinal: true,
      startsAt: true,
      endsAt: true,
      completionStatus: true,
      movedAt: true,
    },
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
