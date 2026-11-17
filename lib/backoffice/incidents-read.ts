/**
 * The Incidents tab's reads: declared incidents with their remedy counts, and
 * a read-only suggestion of hours that look like an outage. Nothing here
 * declares an incident; only an operator does.
 */

import prisma from "@/lib/prisma";
import {
  DEAD_LETTER_PREFIX,
  MAX_REMEDY_ATTEMPTS,
} from "@/lib/booking/incident-keys";
import type { MeetingEndReason } from "@/lib/meetings/end-reasons";

const HOUR_MS = 3_600_000;
const SUGGESTION_DAYS = 7;
const SIGNAL_ROWS_CAP = 5_000;
/** Ends a call can have without anything having gone wrong. */
const EXPECTED_END_REASONS: MeetingEndReason[] = [
  "call_ended",
  "session_timeout",
  "ended_early",
  "reconciled",
];
/** A bucket is flagged at this many signals and this multiple of the hourly mean. */
const MIN_SIGNALS = 5;
const BASELINE_MULTIPLE = 3;

export interface IncidentListRow {
  id: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  declaredBy: string | null;
  createdAt: string;
  enumeratedAt: string | null;
  reportedAt: string | null;
  settledAt: string | null;
  remedies: { due: number; done: number; rebooked: number; failed: number };
}

const countsBy = (
  groups: { incidentId: string; _count: { _all: number } }[],
): Map<string, number> =>
  new Map(groups.map((g) => [g.incidentId, g._count._all]));

export const INCIDENTS_PAGE_SIZE = 20;

/** One page of declared incidents, newest first, with the total for the pager. */
export async function readIncidents(
  page = 1,
): Promise<{ rows: IncidentListRow[]; total: number }> {
  const total = await prisma.platformIncident.count();
  const incidents = await prisma.platformIncident.findMany({
    relationLoadStrategy: "join",
    orderBy: [{ startsAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * INCIDENTS_PAGE_SIZE,
    take: INCIDENTS_PAGE_SIZE,
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      reason: true,
      createdAt: true,
      enumeratedAt: true,
      reportedAt: true,
      settledAt: true,
      declaredByUser: { select: { name: true } },
    },
  });
  if (incidents.length === 0) return { rows: [], total };
  const incidentId = { in: incidents.map((i) => i.id) };
  const due = await prisma.incidentRemedy.groupBy({
    by: ["incidentId"],
    where: { incidentId, doneAt: null, attempts: { lt: MAX_REMEDY_ATTEMPTS } },
    _count: { _all: true },
  });
  const done = await prisma.incidentRemedy.groupBy({
    by: ["incidentId"],
    where: { incidentId, doneAt: { not: null }, rebookedOccurrenceId: null },
    _count: { _all: true },
  });
  const rebooked = await prisma.incidentRemedy.groupBy({
    by: ["incidentId"],
    where: { incidentId, rebookedOccurrenceId: { not: null } },
    _count: { _all: true },
  });
  const failed = await prisma.incidentRemedy.groupBy({
    by: ["incidentId"],
    where: {
      incidentId,
      doneAt: null,
      lastError: { startsWith: DEAD_LETTER_PREFIX },
    },
    _count: { _all: true },
  });
  const [dueBy, doneBy, rebookedBy, failedBy] = [
    due,
    done,
    rebooked,
    failed,
  ].map(countsBy);
  const rows = incidents.map((i) => ({
    id: i.id,
    startsAt: i.startsAt.toISOString(),
    endsAt: i.endsAt.toISOString(),
    reason: i.reason,
    declaredBy: i.declaredByUser?.name ?? null,
    createdAt: i.createdAt.toISOString(),
    enumeratedAt: i.enumeratedAt?.toISOString() ?? null,
    reportedAt: i.reportedAt?.toISOString() ?? null,
    settledAt: i.settledAt?.toISOString() ?? null,
    remedies: {
      due: dueBy.get(i.id) ?? 0,
      done: doneBy.get(i.id) ?? 0,
      rebooked: rebookedBy.get(i.id) ?? 0,
      failed: failedBy.get(i.id) ?? 0,
    },
  }));
  return { rows, total };
}

export interface SuggestedWindow {
  startsAt: string;
  endsAt: string;
  signals: number;
}

/**
 * Hours whose signal count is clearly above the 7-day hourly mean; pure.
 * Signals: an unverified or outage verdict, an unexpected call end, a failed webhook.
 */
export function suggestIncidentWindows(
  signals: readonly Date[],
  now: Date,
): SuggestedWindow[] {
  const hours = SUGGESTION_DAYS * 24;
  const lastHour = Math.floor(now.getTime() / HOUR_MS);
  const counts = new Map<number, number>();
  for (const at of signals) {
    const hour = Math.floor(at.getTime() / HOUR_MS);
    if (hour <= lastHour - hours || hour > lastHour) continue;
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  const mean = signals.length / hours;
  return [...counts.entries()]
    .filter(([, n]) => n >= MIN_SIGNALS && n >= BASELINE_MULTIPLE * mean)
    .sort((a, b) => b[0] - a[0])
    .map(([hour, n]) => ({
      startsAt: new Date(hour * HOUR_MS).toISOString(),
      endsAt: new Date(
        Math.min((hour + 1) * HOUR_MS, now.getTime()),
      ).toISOString(),
      signals: n,
    }));
}

export async function readIncidentSuggestions(
  now = new Date(),
): Promise<SuggestedWindow[]> {
  const from = new Date(now.getTime() - SUGGESTION_DAYS * 24 * HOUR_MS);
  const sessions = await prisma.appointmentOccurrence.findMany({
    where: {
      startsAt: { gte: from, lt: now },
      outcome: {
        in: ["PLATFORM_OUTAGE", "INCONCLUSIVE", "OFFLINE", "NOBODY_JOINED"],
      },
    },
    select: { startsAt: true },
    take: SIGNAL_ROWS_CAP,
  });
  const meetings = await prisma.meeting.findMany({
    where: {
      endedAt: { gte: from, lt: now },
      endedReason: { not: null, notIn: EXPECTED_END_REASONS },
    },
    select: { endedAt: true },
    take: SIGNAL_ROWS_CAP,
  });
  const webhooks = await prisma.webhookEvent.findMany({
    where: { receivedAt: { gte: from, lt: now }, error: { not: null } },
    select: { receivedAt: true },
    take: SIGNAL_ROWS_CAP,
  });
  return suggestIncidentWindows(
    [
      ...sessions.map((s) => s.startsAt),
      ...meetings.flatMap((m) => (m.endedAt ? [m.endedAt] : [])),
      ...webhooks.map((w) => w.receivedAt),
    ],
    now,
  );
}
