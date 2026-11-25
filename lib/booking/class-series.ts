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
 *   - delivered = endsAt ≤ now and not CANCELLED/RESCHEDULED/VOIDED; in progress =
 *     a live SCHEDULED row with startsAt ≤ now < endsAt; remaining = live
 *     SCHEDULED rows starting after now; neverScheduled is the rest.
 *   - An in-progress session counts as delivered when the attendee leaves
 *     (they chose to go after it started) and as refundable when the host
 *     cancels the series (the host's act, not the buyer's).
 */

import type {
  OccurrenceCompletionStatus,
  OccurrenceOutcome,
} from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { HOST_ATTRIBUTED_OUTCOMES } from "./session-outcome";
import { INCIDENT_REFUND_KEY_PREFIX } from "./incident-keys";
import { missedAt } from "./misses";

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
  /** Held sessions under way right now: delivered for a leave, refundable for a host cancel. */
  inProgressHeld: number;
  /** Live sessions the seat holds that have not started, earliest first. */
  remaining: { startsAt: Date; movedAt: Date | null }[];
  neverScheduled: number;
  /** Sessions sold to the seat that no row ever placed: not delivered, live or missed, by distinct ordinal. */
  unplaced: number;
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

const isInProgress = (o: LedgerOccurrence, now: Date) =>
  o.completionStatus === "SCHEDULED" && o.startsAt <= now && o.endsAt > now;

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
  const inProgress = held.filter((o) => isInProgress(o, now));
  const remaining = held
    .filter((o) => isLiveAhead(o, now))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  // A missed session (host-cancelled or voided) keeps its place in the seat's
  // count (E-2): it is made up or refunded one unit, so the unit must not move.
  const missed = held.filter(isMissed);
  const ordinals = new Set(
    [...delivered, ...inProgress, ...remaining, ...missed].map(
      (o) => o.ordinal,
    ),
  );
  const heldCount = args.sessionsPurchased || Math.min(N, ordinals.size) || N;
  const deliveredHeld = Math.min(delivered.length, heldCount);
  const inProgressHeld = Math.min(inProgress.length, heldCount - deliveredHeld);
  return {
    N,
    heldCount,
    unitPaise: BigInt(args.amountPaise) / BigInt(Math.max(heldCount, 1)),
    deliveredHeld,
    inProgressHeld,
    remaining: remaining.map((o) => ({
      startsAt: o.startsAt,
      movedAt: o.movedAt,
    })),
    neverScheduled: Math.max(
      0,
      heldCount - deliveredHeld - inProgressHeld - remaining.length,
    ),
    unplaced: Math.max(0, heldCount - ordinals.size),
  };
}

/** A seat's ledger plus what it already got back per session (D-5). */
export type SeriesSeat = SeatLedger & { occRefundedPaise?: number };

/**
 * What a host cancelling the whole series refunds this seat (D-5): everything
 * not yet delivered, the session under way included.
 */
export function seriesCancelRefundPaise(
  ledger: SeatLedger,
  amountPaise: bigint | number,
): bigint {
  const left =
    BigInt(amountPaise) - ledger.unitPaise * BigInt(ledger.deliveredHeld);
  return left > BigInt(0) ? left : BigInt(0);
}

/**
 * What a seat released at `releasedAt` is owed for what it was not delivered:
 * its amount less one unit per held session that had ended by then. A session
 * under way at the release, and any the class held afterwards, is not
 * delivered. The unit is read at `now`, when every placed session is on record.
 */
export function releasedSeatRefundPaise(args: {
  N: number;
  amountPaise: bigint | number;
  joinedAt: Date;
  occurrences: LedgerOccurrence[];
  sessionsPurchased?: number | null;
  releasedAt: Date;
  now: Date;
}): { refundPaise: bigint; deliveredHeld: number } {
  const { unitPaise, heldCount } = seatLedgerFrom(args);
  const deliveredHeld = Math.min(
    seatLedgerFrom({ ...args, now: args.releasedAt }).deliveredHeld,
    heldCount,
  );
  const left = BigInt(args.amountPaise) - unitPaise * BigInt(deliveredHeld);
  return {
    refundPaise: left > BigInt(0) ? left : BigInt(0),
    deliveredHeld,
  };
}

/** The key prefix of the refund a completed class owes a seat for sessions it sold but never placed. */
export const CLASS_END_REFUND_KEY_PREFIX = "class-end:";

/**
 * What a class completing short owes this seat for the sessions it was sold but
 * no row ever placed: floor(amount × unplaced / heldCount), in BigInt.
 */
export function classEndRefundPaise(
  ledger: SeatLedger,
  amountPaise: bigint | number,
): bigint {
  if (ledger.unplaced <= 0 || ledger.heldCount <= 0) return BigInt(0);
  return (
    (BigInt(amountPaise) * BigInt(ledger.unplaced)) / BigInt(ledger.heldCount)
  );
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

/** A seat's ledger counts confirmed, untombstoned rows only. */
const LEDGER_OCCURRENCE_WHERE = {
  deletedAt: null,
  isTentative: false,
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
    where: { appointmentId: seat.appointmentId, ...LEDGER_OCCURRENCE_WHERE },
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

/** {@link seatLedger}'s plan size and sessions for many wrappers, in two reads whatever their count. */
export async function seatSessionsByAppointment(
  db: Pick<Tx, "appointment" | "appointmentOccurrence">,
  appointmentIds: readonly string[],
): Promise<Map<string, { N: number; occurrences: LedgerOccurrence[] }>> {
  const ids = [...new Set(appointmentIds)];
  // Sequential: the caller's transaction runs one statement at a time.
  const appointments = await db.appointment.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      class: { select: { classPlan: { select: { totalSessions: true } } } },
    },
  });
  const rows = await db.appointmentOccurrence.findMany({
    where: { appointmentId: { in: ids }, ...LEDGER_OCCURRENCE_WHERE },
    select: { ...LEDGER_OCCURRENCE_SELECT, appointmentId: true },
  });
  const sessions = new Map<
    string,
    { N: number; occurrences: LedgerOccurrence[] }
  >();
  for (const id of ids) {
    const occurrences = rows.filter((o) => o.appointmentId === id);
    const planSize = appointments.find((a) => a.id === id)?.class?.classPlan
      ?.totalSessions;
    sessions.set(id, { N: planSize ?? occurrences.length, occurrences });
  }
  return sessions;
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
  /** When each host miss was lost (the cancel or the void), for the rolling window. */
  hostMissAts: Date[];
  /** Total misses at which the exit right opens whatever their spacing. */
  exitThreshold: number;
  /** The learner may leave with every undelivered session refunded (E-5). */
  exitRight: boolean;
}

const DAY_MS = 86_400_000;

/** Host misses that open the exit right when they all fall inside one window. */
export const EXIT_WINDOW_MISSES = 3;
export const EXIT_WINDOW_DAYS = 30;

/** Total misses that open the exit right: max(3, ceil(15 % of N)); integer math, so 100 → 15. */
export const exitThresholdFor = (N: number): number =>
  Math.max(3, Math.ceil((15 * N) / 100));

/** Whether `count` of `times` fall inside one window shorter than `windowMs`. */
function clustered(times: Date[], count: number, windowMs: number): boolean {
  const sorted = times.map((t) => t.getTime()).sort((a, b) => a - b);
  for (let i = count - 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - count + 1] < windowMs) return true;
  }
  return false;
}

/**
 * The learner's exit right: 3 host misses inside any rolling 30 days, or total
 * misses ≥ max(3, 15 % of N). Any window, not the last 30 days, so it stays for
 * the class unless an ops correction removes a miss; a right already used is final.
 */
export const exitRightFor = (l: {
  hostMissAts: Date[];
  misses: number;
  N: number;
}): boolean =>
  clustered(l.hostMissAts, EXIT_WINDOW_MISSES, EXIT_WINDOW_DAYS * DAY_MS) ||
  l.misses >= exitThresholdFor(l.N);

/** The same rule over host misses alone: what raises the host's reliability flag. */
export const reliabilityThresholdMet = (ledger: SeriesLedger): boolean =>
  exitRightFor({
    hostMissAts: ledger.hostMissAts,
    misses: ledger.hostMisses,
    N: ledger.N,
  });

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
  const hostMissAts = args.occurrences
    .filter(isHostMiss)
    .flatMap((o) => missedAt(o) ?? []);
  return {
    N,
    delivered,
    remaining,
    neverScheduled: Math.max(0, N - delivered - remaining),
    misses,
    hostMisses: hostMissAts.length,
    hostMissAts,
    exitThreshold: exitThresholdFor(N),
    exitRight: exitRightFor({ hostMissAts, misses, N }),
  };
}

/** The class wrapper's live sessions and its plan size N, on the caller's client. */
async function readSeries(
  db: Pick<Tx, "appointment" | "appointmentOccurrence">,
  appointmentId: string,
) {
  const appointment = await db.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      class: { select: { classPlan: { select: { totalSessions: true } } } },
    },
  });
  const occurrences = await db.appointmentOccurrence.findMany({
    where: { appointmentId, deletedAt: null, isTentative: false },
    select: { ...LEDGER_OCCURRENCE_SELECT, id: true },
  });
  return {
    N: appointment?.class?.classPlan?.totalSessions ?? occurrences.length,
    occurrences,
  };
}

/** Reads the class wrapper's sessions and plan size on the caller's client. */
export async function seriesLedger(
  db: Pick<Tx, "appointment" | "appointmentOccurrence">,
  appointmentId: string,
  now = new Date(),
): Promise<SeriesLedger> {
  return seriesLedgerFrom({ ...(await readSeries(db, appointmentId)), now });
}

/**
 * A miss that just landed on one session: a new one (a host cancel or a void),
 * or, `relabelled`, an existing void newly blamed on the host.
 */
export type LandedMiss = { occurrenceId: string; relabelled?: boolean };

/**
 * The series ledger now, and whether the exit right already stood before
 * `landed`; the miss that first trips it is the one whose bells and emails go
 * out. The class wrapper's row lock serialises concurrent misses (a cancel and
 * an outcome sweep), so the second one reads the first and never trips again.
 */
export async function seriesLedgerAfterMiss(
  db: Pick<Tx, "appointment" | "appointmentOccurrence" | "$executeRaw">,
  appointmentId: string,
  landed: LandedMiss,
  now: Date,
): Promise<{ ledger: SeriesLedger; heldBefore: boolean }> {
  // NO KEY UPDATE: serialises misses, yet stays compatible with the KEY SHARE a history row's FK takes.
  await db.$executeRaw`SELECT 1 FROM "Appointment" WHERE id = ${appointmentId} FOR NO KEY UPDATE`;
  const { N, occurrences } = await readSeries(db, appointmentId);
  const before = occurrences.map((o) => {
    if (o.id !== landed.occurrenceId) return o;
    return landed.relabelled
      ? { ...o, outcome: null }
      : { ...o, hostCancelledAt: null, voidedAt: null };
  });
  return {
    ledger: seriesLedgerFrom({ N, occurrences, now }),
    heldBefore: seriesLedgerFrom({ N, occurrences: before, now }).exitRight,
  };
}

/** Seat doors whose refund returns sessions of this payment: a leave (the re-time free leave included), the exit right and class-end settlement. */
const SEAT_REFUND_KEY_PREFIXES = [
  "seat-leave:",
  "seat-exit:",
  CLASS_END_REFUND_KEY_PREFIX,
] as const;

/** Per-payment refund keys end in `:pay:<paymentId>`; an incident key names no payment. */
const PAYMENT_KEYED_PREFIXES = ["occ:", ...SEAT_REFUND_KEY_PREFIXES] as const;

/** Whether a refund on `paymentId` returns sessions of it: the one dedupe-key predicate. */
function returnsSessionsOf(dedupeKey: string | null, paymentId: string) {
  if (!dedupeKey) return false;
  if (dedupeKey.startsWith(INCIDENT_REFUND_KEY_PREFIX)) return true;
  return (
    PAYMENT_KEYED_PREFIXES.some((prefix) => dedupeKey.startsWith(prefix)) &&
    dedupeKey.endsWith(`:pay:${paymentId}`)
  );
}

/**
 * What each payment already got back for sessions it will not be delivered:
 * per session (`occ:*`, `incident:*`) and per seat (`seat-leave:*`,
 * `seat-exit:*`, `class-end:*`), in one read whatever the count.
 */
export async function occurrenceRefundsByPayment(
  db: Pick<Tx, "refund">,
  paymentIds: readonly string[],
): Promise<Map<string, number>> {
  const totals = new Map(paymentIds.map((id) => [id, 0]));
  if (totals.size === 0) return totals;
  const rows = await db.refund.findMany({
    where: {
      paymentId: { in: [...totals.keys()] },
      status: { in: ["SUCCEEDED", "PENDING"] },
      OR: [INCIDENT_REFUND_KEY_PREFIX, ...PAYMENT_KEYED_PREFIXES].map(
        (prefix) => ({ dedupeKey: { startsWith: prefix } }),
      ),
    },
    select: { paymentId: true, dedupeKey: true, amountPaise: true },
  });
  for (const r of rows) {
    if (!returnsSessionsOf(r.dedupeKey, r.paymentId)) continue;
    totals.set(
      r.paymentId,
      (totals.get(r.paymentId) ?? 0) + Number(r.amountPaise),
    );
  }
  return totals;
}

/** {@link occurrenceRefundsByPayment} for one payment. */
export async function occurrenceRefundsPaise(
  db: Pick<Tx, "refund">,
  paymentId: string,
): Promise<number> {
  return (
    (await occurrenceRefundsByPayment(db, [paymentId])).get(paymentId) ?? 0
  );
}
