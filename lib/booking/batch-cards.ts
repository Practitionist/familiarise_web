/**
 * #1819 — one card per class batch, shared by the explore page, the checkout
 * header and the host's class list so all three agree. Pure; client-safe.
 */

import { formatInTimeZone } from "date-fns-tz";

import {
  effectiveMaxParticipants,
  getClassCapacity,
} from "@/lib/events/capacity";
import {
  classEnrolmentFrom,
  type ClassEnrolment,
  type EnrolmentSession,
} from "./class-enrolment";

export type BatchPhase = "upcoming" | "running" | "completed" | "unscheduled";

export interface BatchCardPlan {
  price: number;
  totalSessions: number;
  sessionsPerWeek: number;
  maxParticipants: number;
  lateJoinUntilSession?: number | null;
}

export interface BatchCardClass {
  id: string;
  status: string;
  maxParticipants?: number | null;
  deletedAt?: Date | string | null;
  appointment?: {
    occurrences: (EnrolmentSession & { endsAt: Date | string })[];
    /** Either the live seats or their count; the seat list excludes the host. */
    participants?: { userId: string }[];
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
  /** Open for enrolment, not full, and not a draft or cancelled batch. */
  canEnrol: boolean;
  /** For a card that cannot be joined: when the next joinable batch starts. */
  nextBatchStartsAt: Date | null;
}

const SELLABLE = new Set(["SCHEDULED", "IN_PROGRESS"]);
const GONE = new Set(["CANCELLED", "RESCHEDULED"]);

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

function seatsFor(cls: BatchCardClass, plan: BatchCardPlan, hostId?: string) {
  if (cls.appointment?.participants) {
    const cap = getClassCapacity({
      classInstance: cls,
      plan,
      excludeUserIds: hostId ? [hostId] : [],
    });
    return { seatsLeft: cap.remaining, isFull: cap.isFull };
  }
  const max = effectiveMaxParticipants(cls, plan);
  const taken = cls.appointment?._count?.participants ?? 0;
  return { seatsLeft: Math.max(0, max - taken), isFull: taken >= max };
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
  opts: { timeZone?: string; hostUserId?: string | null } = {},
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
      const seats = seatsFor(cls, plan, opts.hostUserId ?? undefined);
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
        enrolment,
        canEnrol:
          enrolment.state === "open" &&
          !seats.isFull &&
          SELLABLE.has(cls.status) &&
          (phase === "upcoming" || phase === "running"),
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
