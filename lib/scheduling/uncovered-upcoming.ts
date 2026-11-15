/**
 * After an availability write, which upcoming sessions now sit outside the
 * consultant's published hours? Availability is an offer for NEW bookings; a
 * SCHEDULED occurrence is a materialized contract that keeps its time
 * (Calendly / Cal.com semantics). So a shrink is allowed, and this is the
 * notice that travels with it — never a refusal. See
 * docs/onboarding/03-availability-contract.md.
 */

import type { Tx } from "@/lib/prisma";
import { recomputeProfileCompletion } from "@/lib/profiles/profile-completion";
import {
  findUncoveredAtomIn,
  WEEKLY_COVERAGE_SELECT,
  windowAtoms,
  type CustomCoverageRow,
  type WeeklyCoverageRow,
} from "@/utils/scheduling-engine/availabilityCoverage";
import {
  createWeeklyCoverage,
  partitionWeeklyRows,
} from "@/utils/schedule/weekly-projection";
import { reportIncompleteWeeklyRows } from "@/lib/scheduling/incomplete-weekly-rows";
import {
  buildDeadHoldFilter,
  OCCUPYING_OCCURRENCE_WHERE,
} from "@/utils/scheduling-engine/occupancyPolicy";

export interface UncoveredSession {
  appointmentId: string;
  startsAt: Date;
  /** Still awaiting payment or approval: a live hold, not a confirmed session. */
  held: boolean;
}

export interface UncoveredUpcoming {
  count: number;
  appointmentIds: string[];
  /** Of `count`, the bookings still awaiting payment or approval (live holds). */
  awaitingConfirmation: number;
  /** The first uncovered session of each booking, soonest first. */
  sessions: UncoveredSession[];
}

export const NONE_UNCOVERED: UncoveredUpcoming = {
  count: 0,
  appointmentIds: [],
  awaitingConfirmation: 0,
  sessions: [],
};

/** Bounded scan: a consultant with more upcoming sessions than this is told about the first ones. */
const SCAN_LIMIT = 500;

export async function findUncoveredUpcoming(
  db: Pick<Tx, "appointmentOccurrence">,
  consultantProfileId: string,
  published: {
    scheduleType: "WEEKLY" | "CUSTOM";
    weeklyRows: WeeklyCoverageRow[];
    customRows: CustomCoverageRow[];
  },
  now: Date = new Date(),
): Promise<UncoveredUpcoming> {
  // Every row that holds the host's time: confirmed sessions and live holds
  // (requests, unpaid approvals, checkouts, pending reschedules), never a lapsed hold.
  const occurrences = await db.appointmentOccurrence.findMany({
    where: {
      consultantProfileId,
      ...OCCUPYING_OCCURRENCE_WHERE,
      startsAt: { gte: now },
      appointment: { deletedAt: null, NOT: buildDeadHoldFilter(now) },
    },
    select: {
      appointmentId: true,
      startsAt: true,
      endsAt: true,
      isTentative: true,
    },
    orderBy: { startsAt: "asc" },
    take: SCAN_LIMIT,
  });
  if (occurrences.length === 0) return NONE_UNCOVERED;

  // ScheduleType is exclusive: the dormant arm publishes nothing.
  const weeklyRows =
    published.scheduleType === "WEEKLY" ? published.weeklyRows : [];
  const customRows =
    published.scheduleType === "CUSTOM" ? published.customRows : [];

  const weekly = createWeeklyCoverage(weeklyRows);
  const sessions = new Map<string, UncoveredSession>();
  const awaiting = new Set<string>();
  for (const occ of occurrences) {
    const atoms = windowAtoms(occ.startsAt, occ.endsAt);
    if (findUncoveredAtomIn(atoms, weekly, customRows)) {
      if (!sessions.has(occ.appointmentId)) {
        sessions.set(occ.appointmentId, {
          appointmentId: occ.appointmentId,
          startsAt: occ.startsAt,
          held: occ.isTentative,
        });
      }
      if (occ.isTentative) awaiting.add(occ.appointmentId);
    }
  }
  return {
    count: sessions.size,
    appointmentIds: Array.from(sessions.keys()),
    awaitingConfirmation: awaiting.size,
    sessions: Array.from(sessions.values()),
  };
}

/**
 * What a proposed availability would newly leave uncovered: the bookings
 * outside the proposed hours that the stored hours still cover. Read-only;
 * the settings form shows it before the save.
 */
export async function previewNewlyUncovered(
  db: Pick<
    Tx,
    | "consultantProfile"
    | "availabilityWindowWeekly"
    | "availabilityWindowCustom"
    | "appointmentOccurrence"
  >,
  consultantProfileId: string,
  proposed: {
    scheduleType: "WEEKLY" | "CUSTOM";
    weeklyRows: WeeklyCoverageRow[];
    customRows: CustomCoverageRow[];
  },
  now: Date = new Date(),
): Promise<{ sessions: UncoveredSession[]; customDatesRemoved: number }> {
  const profile = await db.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: {
      scheduleType: true,
      availabilityWindowsWeekly: { select: WEEKLY_COVERAGE_SELECT },
      availabilityWindowsCustom: { select: { startsAt: true, endsAt: true } },
    },
  });
  if (!profile) return { sessions: [], customDatesRemoved: 0 };
  const [before, after] = await Promise.all([
    findUncoveredUpcoming(
      db,
      consultantProfileId,
      {
        scheduleType: profile.scheduleType,
        weeklyRows: partitionWeeklyRows(profile.availabilityWindowsWeekly)
          .usable,
        customRows: profile.availabilityWindowsCustom,
      },
      now,
    ),
    findUncoveredUpcoming(db, consultantProfileId, proposed, now),
  ]);
  const already = new Set(before.appointmentIds);
  return {
    sessions: after.sessions.filter((s) => !already.has(s.appointmentId)),
    // A weekly save replaces the custom dates; count the ones still ahead.
    customDatesRemoved:
      proposed.scheduleType === "WEEKLY"
        ? profile.availabilityWindowsCustom.filter((row) => row.endsAt > now)
            .length
        : 0,
  };
}

export interface AvailabilityWriteSettlement {
  uncoveredUpcoming: UncoveredUpcoming;
  profileCompletion: number;
}

/**
 * The tail every availability write shares, run inside the writer's
 * transaction so it sees the rows that were actually stored: the shrink
 * notice above, and the profile-completion recompute (#698 OB-1 — the
 * availability bit of the score flips here).
 */
export async function settleAvailabilityWrite(
  db: Pick<
    Tx,
    | "consultantProfile"
    | "availabilityWindowWeekly"
    | "availabilityWindowCustom"
    | "appointmentOccurrence"
  >,
  consultantProfileId: string,
  now: Date = new Date(),
): Promise<AvailabilityWriteSettlement> {
  const profile = await db.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: {
      scheduleType: true,
      // No `deletedAt` filter: availability rows are removed by `deleteMany`
      // (see the consultant delete door), never tombstoned, so the filter could
      // only ever hide nothing — and the columns no longer exist.
      availabilityWindowsWeekly: { select: WEEKLY_COVERAGE_SELECT },
      availabilityWindowsCustom: {
        select: { startsAt: true, endsAt: true },
      },
    },
  });
  const weekly = partitionWeeklyRows(profile?.availabilityWindowsWeekly ?? []);
  reportIncompleteWeeklyRows(weekly.refused, {
    op: "settle-availability-write",
    consultantProfileId,
  });
  const uncoveredUpcoming = profile
    ? await findUncoveredUpcoming(
        db,
        consultantProfileId,
        {
          scheduleType: profile.scheduleType,
          weeklyRows: weekly.usable,
          customRows: profile.availabilityWindowsCustom,
        },
        now,
      )
    : NONE_UNCOVERED;
  const profileCompletion = await recomputeProfileCompletion(
    db,
    consultantProfileId,
  );
  return { uncoveredUpcoming, profileCompletion };
}
