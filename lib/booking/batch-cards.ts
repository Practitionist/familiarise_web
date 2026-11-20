/**
 * #1819 — one card per class batch, shared by the explore page, the checkout
 * header and the host's class list so all three agree. Pure; client-safe.
 */

import { formatInTimeZone } from "date-fns-tz";

import { eventCapacityFromCount } from "@/lib/events/capacity";
import { eventRefundWindowHours } from "@/lib/payments/operations/cancellation-policy";
import {
  classEnrolmentFrom,
  type ClassEnrolment,
  type EnrolmentSession,
} from "./class-enrolment";
import { MAKEUP_WINDOW_DAYS } from "./misses";

export type BatchPhase = "upcoming" | "running" | "completed" | "unscheduled";

export interface BatchCardPlan {
  price: number;
  totalSessions: number;
  sessionsPerWeek: number;
  maxParticipants: number;
  lateJoinUntilSession?: number | null;
  /** The listing's free-cancellation window; null means the 24-hour default. */
  refundWindowHours?: number | null;
}

export interface BatchCardClass {
  id: string;
  status: string;
  maxParticipants?: number | null;
  deletedAt?: Date | string | null;
  appointment?: {
    occurrences: (EnrolmentSession & {
      endsAt: Date | string;
      /** Set on a session the host cancelled; its make-up window runs from here. */
      hostCancelledAt?: Date | string | null;
    })[];
    /** Seats taken, host excluded; the public payload never lists who holds them. */
    _count?: { participants: number };
  } | null;
}

export interface BatchCard {
  classId: string;
  phase: BatchPhase;
  /** The first live session's start, or null before scheduling. */
  startsAt: Date | null;
  endsAt: Date | null;
  /** "Starts Mon 28 Sep · Mondays". */
  label: string;
  seatsLeft: number;
  isFull: boolean;
  enrolment: ClassEnrolment;
  /** A seat bought now cancels free until this instant (next session − window); null once past. */
  freeCancellationUntil: Date | null;
  /** Open for enrolment, fully planned, not full, and not a draft or cancelled batch. */
  canEnrol: boolean;
  /** For a card that cannot be joined: when the next joinable batch starts. */
  nextBatchStartsAt: Date | null;
}

const SELLABLE = new Set(["SCHEDULED"]);
const GONE = new Set(["CANCELLED", "RESCHEDULED"]);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sessions of a batch that count as planned for a new seat: every live row (a
 * released one awaits its new time), plus a session the host cancelled whose
 * make-up is still owed inside the make-up window. Checkout sells a seat only
 * once this reaches the plan's total, and the card offers Enrol by the same count.
 */
export function plannedSessionCount(
  occurrences: ReadonlyArray<{
    ordinal?: number | null;
    startsAt: Date | string;
    completionStatus: string;
    deletedAt?: Date | string | null;
    hostCancelledAt?: Date | string | null;
  }>,
  now: Date,
): number {
  const key = (o: { ordinal?: number | null; startsAt: Date | string }) =>
    o.ordinal ?? new Date(o.startsAt).getTime();
  const rows = occurrences.filter((o) => !o.deletedAt);
  const live = rows.filter((o) => o.completionStatus !== "CANCELLED");
  // A make-up takes its cancelled session's ordinal, so that session is not counted twice.
  const placed = new Set(live.map(key));
  const owed = new Set(
    rows
      .filter(
        (o) =>
          o.completionStatus === "CANCELLED" &&
          !!o.hostCancelledAt &&
          now.getTime() <
            new Date(o.hostCancelledAt).getTime() +
              MAKEUP_WINDOW_DAYS * DAY_MS &&
          !placed.has(key(o)),
      )
      .map(key),
  );
  return live.length + owed.size;
}

/** "Mondays", "Mondays and Thursdays", or "Varies" when the days drift. */
function weekdayPattern(starts: Date[], perWeek: number, tz: string) {
  const days = new Map<number, string>();
  for (const d of starts) {
    days.set(
      Number(formatInTimeZone(d, tz, "i")),
      `${formatInTimeZone(d, tz, "EEEE")}s`,
    );
  }
  if (days.size === 0 || days.size > Math.max(perWeek, 1)) return "Varies";
  const names = [...days.entries()]
    .sort((a, b) => a[0] - b[0])
    .map((e) => e[1]);
  return names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function seatsFor(cls: BatchCardClass, plan: BatchCardPlan) {
  const cap = eventCapacityFromCount({
    instance: cls,
    plan,
    taken: cls.appointment?._count?.participants ?? 0,
  });
  return { seatsLeft: cap.remaining, isFull: cap.isFull };
}

function phaseOf(
  cls: BatchCardClass,
  start: Date | null,
  end: Date | null,
  now: Date,
): BatchPhase {
  if (!start || !end) return "unscheduled";
  if (cls.status === "COMPLETED" || end <= now) return "completed";
  return start <= now ? "running" : "upcoming";
}

function labelOf(
  phase: BatchPhase,
  start: Date | null,
  pattern: string,
  tz: string,
) {
  if (!start) return "Schedule to be announced";
  const day = formatInTimeZone(start, tz, "EEE d MMM");
  if (phase === "upcoming") return `Starts ${day} · ${pattern}`;
  if (phase === "running") return `Started ${day} · ${pattern}`;
  return `Ran from ${day} · ${pattern}`;
}

/** Running and upcoming batches by first session, then unscheduled, then
 *  completed (latest first); cancelled and deleted batches are left out. */
export function deriveBatchCards(
  plan: BatchCardPlan,
  classes: BatchCardClass[],
  now: Date,
  opts: { timeZone?: string } = {},
): BatchCard[] {
  const tz = opts.timeZone ?? "UTC";
  const cards = classes
    .filter((c) => c.status !== "CANCELLED" && !c.deletedAt)
    .map((cls): BatchCard => {
      const sessions = (cls.appointment?.occurrences ?? []).filter(
        (o) => !o.deletedAt && !GONE.has(o.completionStatus),
      );
      const starts = sessions
        .map((o) => new Date(o.startsAt))
        .sort((a, b) => +a - +b);
      const ends = sessions
        .map((o) => new Date(o.endsAt))
        .sort((a, b) => +a - +b);
      const startsAt = starts[0] ?? null;
      const endsAt = ends.at(-1) ?? null;
      const phase = phaseOf(cls, startsAt, endsAt, now);
      const enrolment = classEnrolmentFrom({
        pricePaise: plan.price,
        N: plan.totalSessions,
        lateJoinUntilSession: plan.lateJoinUntilSession,
        sessions: cls.appointment?.occurrences ?? [],
        now,
      });
      const seats = seatsFor(cls, plan);
      const nextAhead = starts.find((d) => d > now);
      const until = nextAhead
        ? new Date(
            nextAhead.getTime() -
              eventRefundWindowHours(null, plan.refundWindowHours) * 3_600_000,
          )
        : null;
      return {
        classId: cls.id,
        phase,
        startsAt,
        endsAt,
        label: labelOf(
          phase,
          startsAt,
          weekdayPattern(starts, plan.sessionsPerWeek, tz),
          tz,
        ),
        ...seats,
        freeCancellationUntil: until && until > now ? until : null,
        enrolment,
        canEnrol:
          enrolment.state === "open" &&
          !seats.isFull &&
          SELLABLE.has(cls.status) &&
          (phase === "upcoming" || phase === "running") &&
          // Checkout refuses a batch whose sessions are not all planned yet.
          plannedSessionCount(cls.appointment?.occurrences ?? [], now) >=
            plan.totalSessions,
        nextBatchStartsAt: null,
      };
    });
  const rank: Record<BatchPhase, number> = {
    running: 0,
    upcoming: 0,
    unscheduled: 1,
    completed: 2,
  };
  cards.sort((a, b) => {
    if (rank[a.phase] !== rank[b.phase]) return rank[a.phase] - rank[b.phase];
    const dir = a.phase === "completed" ? -1 : 1;
    return dir * ((a.startsAt?.getTime() ?? 0) - (b.startsAt?.getTime() ?? 0));
  });
  for (const card of cards) {
    if (card.canEnrol) continue;
    card.nextBatchStartsAt =
      cards.find(
        (c) =>
          c.canEnrol &&
          c.phase === "upcoming" &&
          c.startsAt &&
          (!card.startsAt || c.startsAt > card.startsAt),
      )?.startsAt ?? null;
  }
  return cards;
}
