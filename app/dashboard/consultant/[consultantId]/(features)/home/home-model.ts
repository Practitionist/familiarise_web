import {
  CONSULTANT_JOIN_WINDOW_MS,
  getOccurrenceJoinState,
  liveOccurrencesOf,
} from "@/lib/appointments/occurrences";
import { getAppointmentLifecycleStatus } from "@/lib/appointments/map-consultant";
import { isConfirmedStatus } from "@/lib/appointments/status";
import { deriveConsultantActionItems } from "@/lib/dashboard/action-items";
import { nextPayoutBatchAt } from "@/lib/dashboard/earnings-state";
import type { InboxRowInput } from "@/lib/dashboard/requests-inbox-state";
import { toStampDate } from "@/lib/dashboard/requests-inbox-state";
import {
  formatForViewer,
  formatInViewerZone,
  type ViewerZone,
} from "@/lib/time/viewer-zone";
import { formatCurrencyAmount } from "@/utils/formatting";
import type { TAppointment } from "@/types/appointment";
import type {
  TConsultantDashboardResponse,
  TPerformanceSnapshot,
} from "@/types/consultant-events";
import {
  getAppointmentTypeAndPlan,
  getConsumeeName,
} from "../../utils/appointmentHelpers";

/** Needs you holds the five most urgent items; the rest wait for a later visit. */
export const NEEDS_YOU_LIMIT = 5;
/** Requests listed one by one; any others fold into a single "N more" line. */
const REQUEST_ROWS_LISTED = 3;
/** Rows the Today and Upcoming lists share before pointing at Appointments. */
export const AGENDA_LIMIT = 5;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const DEADLINE_PATTERN = "EEE d MMM, h:mm a";
export const SESSION_PATTERN = DEADLINE_PATTERN;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// ---------------------------------------------------------------------------
// Needs you
// ---------------------------------------------------------------------------

export interface HomeNeedsItem {
  key: string;
  /** The one line: what is waiting. */
  text: string;
  /** Muted tail on the same line: the deadline or the reason. */
  detail?: string;
  ctaLabel: string;
  href: string;
}

interface RankedItem extends HomeNeedsItem {
  /** Lower first. Deadline-driven work, then replies, then setup, then the rest. */
  tier: number;
  /** Within a tier: the deadline in ms; items without one keep arrival order. */
  at: number;
}

/** The slice of an inbox row Needs you reads. */
export type NeedsYouRow = Pick<
  InboxRowInput,
  | "id"
  | "requester"
  | "planTitle"
  | "deadline"
  | "bucket"
  | "checkoutHold"
  | "requestedStartPassed"
>;

export interface HomeNeedsInput {
  /** The Requests inbox's first page; undefined while it loads or when it failed. */
  requestRows: readonly NeedsYouRow[] | undefined;
  needsYou: TConsultantDashboardResponse["needsYou"];
  payoutSetup: TConsultantDashboardResponse["payoutSetup"];
  unreadMessages: number;
  basePath: string;
  viewerZone: ViewerZone;
  now: Date;
}

function requestDetail(
  row: NeedsYouRow,
  viewerZone: ViewerZone,
  now: Date,
): string {
  if (row.requestedStartPassed) return "Requested time has passed";
  if (row.deadline === null) return "Waiting for your reply";
  const deadline = toStampDate(row.deadline);
  if (deadline.getTime() <= now.getTime()) return "Reply time has passed";
  return `Reply by ${formatForViewer(deadline, viewerZone, DEADLINE_PATTERN)}`;
}

/** Rows waiting on the expert: a pay link or a checkout in progress is the learner's move. */
function answerableRows(rows: readonly NeedsYouRow[]): NeedsYouRow[] {
  return rows.filter(
    (row) => row.bucket !== "waiting-on-them" && !row.checkoutHold,
  );
}

export function deriveHomeNeedsYou({
  requestRows,
  needsYou,
  payoutSetup,
  unreadMessages,
  basePath,
  viewerZone,
  now,
}: HomeNeedsInput): HomeNeedsItem[] {
  const ranked: RankedItem[] = [];

  const listed = answerableRows(requestRows ?? []).slice(
    0,
    REQUEST_ROWS_LISTED,
  );
  listed.forEach((row, index) => {
    const deadline = row.deadline === null ? null : toStampDate(row.deadline);
    ranked.push({
      key: `request:${row.id}`,
      text: `${row.requester.name} · ${row.planTitle}`,
      detail: requestDetail(row, viewerZone, now),
      ctaLabel: "Answer",
      href: `${basePath}/requests?focus=${encodeURIComponent(row.id)}`,
      tier: deadline ? 0 : 2,
      at: deadline ? deadline.getTime() : index,
    });
  });

  const remaining = Math.max(
    0,
    (needsYou?.requestsToAnswer ?? 0) - listed.length,
  );
  if (remaining > 0) {
    ranked.push({
      key: "requests-more",
      text:
        listed.length > 0
          ? `${remaining} more ${plural(remaining, "request", "requests")} to answer`
          : `${remaining} ${plural(remaining, "request", "requests")} to answer`,
      ctaLabel: "Answer",
      href: `${basePath}/requests`,
      tier: 2,
      at: Number.MAX_SAFE_INTEGER,
    });
  }

  // Everything else the dashboard already derives (payout setup, reschedule
  // replies, make-ups, documents, invitations, reviews) keeps its wording.
  const derived = deriveConsultantActionItems({
    pendingApprovals: 0,
    documentsAwaitingReview: needsYou?.documentsAwaitingReview ?? 0,
    rescheduleReplies: needsYou?.rescheduleReplies ?? [],
    owedMakeUps: needsYou?.owedMakeUps ?? [],
    collabInvites: needsYou?.collabInvites ?? 0,
    reviewsToReply: needsYou?.reviewsToReply ?? 0,
    upcomingSessions: [],
    basePath,
    payoutSetupNeeded: payoutSetup?.needed ?? false,
    livePayoutsEnabled: payoutSetup?.livePayoutsEnabled ?? true,
    viewerTimezone: viewerZone.zone,
    now,
  });
  const makeUps = new Map(
    (needsYou?.owedMakeUps ?? []).map((m) => [m.occurrenceId, m]),
  );
  derived.forEach((item, index) => {
    const base = {
      key: item.key,
      text: item.title,
      ctaLabel: item.ctaLabel,
      href: item.ctaHref,
    };
    if (item.key.startsWith("make-up:")) {
      const owed = makeUps.get(item.key.slice("make-up:".length));
      const deadline = owed ? new Date(owed.deadline) : null;
      ranked.push({
        ...base,
        detail: deadline
          ? `Hold it by ${formatInViewerZone(deadline, viewerZone.zone, "d MMM")}`
          : undefined,
        tier: 0,
        at: deadline ? deadline.getTime() : Number.MAX_SAFE_INTEGER,
      });
    } else if (item.key.startsWith("reschedule-reply:")) {
      ranked.push({ ...base, tier: 1, at: index });
    } else if (item.key === "payout-setup") {
      ranked.push({ ...base, tier: 3, at: index });
    } else {
      ranked.push({ ...base, tier: 5, at: index });
    }
  });

  if (unreadMessages > 0) {
    ranked.push({
      key: "unread-messages",
      text: `${unreadMessages} unread ${plural(unreadMessages, "message", "messages")}`,
      ctaLabel: "Open",
      href: `${basePath}/messages`,
      tier: 4,
      at: 0,
    });
  }

  return ranked
    .toSorted((a, b) => a.tier - b.tier || a.at - b.at)
    .slice(0, NEEDS_YOU_LIMIT)
    .map(({ key, text, detail, ctaLabel, href }) => ({
      key,
      text,
      detail,
      ctaLabel,
      href,
    }));
}

// ---------------------------------------------------------------------------
// Sessions: next, then, and the booked-time glance
// ---------------------------------------------------------------------------

export interface HomeSession {
  occurrenceId: string;
  appointment: TAppointment;
  occurrence: TAppointment["occurrences"][number];
  startsAt: Date;
  endsAt: Date | null;
  /** The learner for a 1:1, the programme for a group session. */
  title: string;
  /** The offering kind and plan, or who attends a group session. */
  subtitle: string;
}

function isGroup(appointment: TAppointment): boolean {
  return (
    appointment.appointmentType === "WEBINAR" ||
    appointment.appointmentType === "CLASS"
  );
}

/**
 * Every confirmed session still to come or in its join window, soonest first.
 * The same predicates the Join button has always used: a live, non-tentative
 * occurrence on a confirmed booking that has not ended.
 */
export function deriveHomeSessions(
  appointments: readonly TAppointment[],
  consultantId: string,
  now: Date,
): HomeSession[] {
  const sessions: HomeSession[] = [];
  for (const appointment of appointments) {
    if (!isConfirmedStatus(getAppointmentLifecycleStatus(appointment))) {
      continue;
    }
    const plan = getAppointmentTypeAndPlan(appointment);
    const who = getConsumeeName(appointment, consultantId);
    for (const occurrence of liveOccurrencesOf(appointment.occurrences ?? [])) {
      if (occurrence.isTentative) continue;
      const state = getOccurrenceJoinState(occurrence, {
        joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
        now,
      });
      if (state === "ended" || state === "disabled") continue;
      sessions.push({
        occurrenceId: occurrence.id,
        appointment,
        occurrence,
        startsAt: new Date(occurrence.startsAt),
        endsAt: occurrence.endsAt ? new Date(occurrence.endsAt) : null,
        title: isGroup(appointment) ? plan : who,
        subtitle: isGroup(appointment) ? who : plan,
      });
    }
  }
  return sessions.toSorted(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
}

/** Join enables 15 minutes before the start and stays on through the rejoin grace. */
export function canJoinNow(session: HomeSession, now: Date): boolean {
  return (
    getOccurrenceJoinState(session.occurrence, {
      joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
      now,
    }) === "joinable"
  );
}

export function joinOpensAt(session: HomeSession): Date {
  return new Date(session.startsAt.getTime() - CONSULTANT_JOIN_WINDOW_MS);
}

const dayKey = (date: Date, zone: string) =>
  formatInViewerZone(date, zone, "yyyy-MM-dd");

/** "in 12 min", "Today", "Tomorrow", "Thursday", or the date; days are the viewer's. */
export function relativeWhen(
  session: HomeSession,
  now: Date,
  zone: string,
): string {
  const start = session.startsAt.getTime();
  const diff = start - now.getTime();
  if (diff <= 0) {
    const end = session.endsAt?.getTime();
    return end === undefined || now.getTime() < end
      ? "Happening now"
      : "Just ended";
  }
  if (diff < 60 * MINUTE_MS) {
    return `In ${Math.max(1, Math.ceil(diff / MINUTE_MS))} min`;
  }
  const today = dayKey(now, zone);
  if (dayKey(session.startsAt, zone) === today) return "Today";
  if (
    dayKey(session.startsAt, zone) ===
    dayKey(new Date(now.getTime() + DAY_MS), zone)
  ) {
    return "Tomorrow";
  }
  return diff < 7 * DAY_MS
    ? formatInViewerZone(session.startsAt, zone, "EEEE")
    : formatInViewerZone(session.startsAt, zone, "d MMM");
}

export function formatDuration(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

export function sessionMinutes(session: HomeSession): number | null {
  if (!session.endsAt) return null;
  return Math.round(
    (session.endsAt.getTime() - session.startsAt.getTime()) / MINUTE_MS,
  );
}

/** What the Join button says while the window is closed: when it opens. */
export function joinOpensLabel(
  session: HomeSession,
  viewerZone: ViewerZone,
): string {
  const opens = joinOpensAt(session);
  const sameDay =
    dayKey(opens, viewerZone.zone) ===
    dayKey(session.startsAt, viewerZone.zone);
  const text = formatForViewer(
    opens,
    viewerZone,
    sameDay ? "h:mm a" : DEADLINE_PATTERN,
  );
  return `Join at ${text}`;
}

export interface Agenda {
  today: HomeSession[];
  upcoming: HomeSession[];
  /** Sessions beyond the cap, for the "All appointments" link. */
  hidden: number;
}

/**
 * Today first, then what follows, capped together. The next session already
 * has its own card, so it is not repeated here. Days are the viewer's.
 */
export function deriveAgenda(
  sessions: readonly HomeSession[],
  now: Date,
  zone: string,
): Agenda {
  const rest = sessions.slice(1);
  const todayKey = dayKey(now, zone);
  const today = rest.filter((s) => dayKey(s.startsAt, zone) === todayKey);
  const later = rest.filter((s) => dayKey(s.startsAt, zone) !== todayKey);
  const shownToday = today.slice(0, AGENDA_LIMIT);
  const shownLater = later.slice(0, AGENDA_LIMIT - shownToday.length);
  return {
    today: shownToday,
    upcoming: shownLater,
    hidden: rest.length - shownToday.length - shownLater.length,
  };
}

/** A quote of at most `max` characters, cut at a word and marked. */
export function excerptOf(body: string, max = 180): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Money, reputation and the glance rows
// ---------------------------------------------------------------------------

export function deriveMoneyLine({
  availablePaise,
  payoutSetup,
  now,
}: {
  availablePaise: number;
  payoutSetup: TConsultantDashboardResponse["payoutSetup"];
  now: Date;
}): string {
  const parts: string[] = [
    availablePaise > 0
      ? `${formatCurrencyAmount(availablePaise, "INR")} ready`
      : "Nothing ready to pay out yet",
  ];
  if (payoutSetup?.needed) {
    parts.push("add a bank account to get paid");
  } else if (payoutSetup?.livePayoutsEnabled === false) {
    parts.push("payouts begin at launch");
  } else if (availablePaise > 0) {
    parts.push(
      `next payout ${formatInViewerZone(nextPayoutBatchAt(now), "UTC", "EEE d MMM")}`,
    );
  }
  return parts.join(" · ");
}

/** "4.8 from 12 learners" per track, only for a track that has a rating. */
export function deriveRatingParts(
  snapshot: TPerformanceSnapshot | undefined,
): string[] {
  if (!snapshot) return [];
  const tracks = [
    {
      label: "1:1",
      score: snapshot.publishedRatingOneToOne,
      count: snapshot.ratedClientsOneToOne,
      one: "learner",
      many: "learners",
    },
    {
      label: "Group",
      score: snapshot.publishedRatingGroup,
      count: snapshot.ratedEventsGroup,
      one: "event",
      many: "events",
    },
  ].flatMap((t) =>
    typeof t.score === "number" && t.count > 0
      ? [{ ...t, score: t.score }]
      : [],
  );
  return tracks.map((t) => {
    const text = `${t.score.toFixed(1)} from ${t.count} ${plural(t.count, t.one, t.many)}`;
    return tracks.length > 1 ? `${t.label} ${text}` : text;
  });
}

export interface GlanceRow {
  label: string;
  value: string;
}

/** Plain rows from data the Home payload already carries; a zero is not shown. */
export function deriveGlanceRows({
  sessions,
  sessionsDelivered,
  responseRate,
  now,
}: {
  sessions: readonly HomeSession[];
  sessionsDelivered: TConsultantDashboardResponse["sessionsDelivered"];
  responseRate: TConsultantDashboardResponse["responseRate"] | undefined;
  now: Date;
}): GlanceRow[] {
  const rows: GlanceRow[] = [];
  if (
    sessionsDelivered &&
    (sessionsDelivered.thisMonth > 0 || sessionsDelivered.lastMonth > 0)
  ) {
    rows.push({
      label: "Sessions delivered",
      value: `${sessionsDelivered.thisMonth} this month · ${sessionsDelivered.lastMonth} last month`,
    });
  }
  const horizon = now.getTime() + 7 * DAY_MS;
  const week = sessions.filter((s) => s.startsAt.getTime() < horizon);
  if (week.length > 0) {
    const minutes = week.reduce((sum, s) => sum + (sessionMinutes(s) ?? 0), 0);
    rows.push({
      label: "Booked, next 7 days",
      value:
        minutes > 0
          ? `${week.length} ${plural(week.length, "session", "sessions")} · ${formatDuration(minutes)}`
          : `${week.length} ${plural(week.length, "session", "sessions")}`,
    });
  }
  if (
    responseRate?.withinTargetPct !== null &&
    responseRate?.withinTargetPct !== undefined
  ) {
    rows.push({
      label: "Replied within a day (30 days)",
      value: `${responseRate.withinTargetPct}%`,
    });
  }
  if (sessionsDelivered && sessionsDelivered.lifetime > 0) {
    rows.push({
      label: "Delivered in total",
      value: String(sessionsDelivered.lifetime),
    });
  }
  return rows;
}
