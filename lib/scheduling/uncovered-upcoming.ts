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
  findUncoveredAtom,
  windowAtoms,
  type CustomCoverageRow,
  type WeeklyCoverageRow,
} from "@/utils/scheduling-engine/availabilityCoverage";

export interface UncoveredUpcoming {
  count: number;
  appointmentIds: string[];
}

export const NONE_UNCOVERED: UncoveredUpcoming = {
  count: 0,
  appointmentIds: [],
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
  const occurrences = await db.appointmentOccurrence.findMany({
    where: {
      consultantProfileId,
      deletedAt: null,
      isTentative: false,
      completionStatus: "SCHEDULED",
      startsAt: { gte: now },
      appointment: { deletedAt: null },
    },
    select: { appointmentId: true, startsAt: true, endsAt: true },
    orderBy: { startsAt: "asc" },
    take: SCAN_LIMIT,
  });
  if (occurrences.length === 0) return NONE_UNCOVERED;

  // ScheduleType is exclusive: the dormant arm publishes nothing.
  const weeklyRows =
    published.scheduleType === "WEEKLY" ? published.weeklyRows : [];
  const customRows =
    published.scheduleType === "CUSTOM" ? published.customRows : [];

  const ids = new Set<string>();
  for (const occ of occurrences) {
    const atoms = windowAtoms(occ.startsAt, occ.endsAt);
    if (findUncoveredAtom(atoms, weeklyRows, customRows)) {
      ids.add(occ.appointmentId);
    }
  }
  return { count: ids.size, appointmentIds: Array.from(ids) };
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
      availabilityWindowsWeekly: {
        where: { deletedAt: null },
        select: {
          startDay: true,
          startTimeUtc: true,
          endTimeUtc: true,
          utcOffsetMinutes: true,
        },
      },
      availabilityWindowsCustom: {
        where: { deletedAt: null },
        select: { startsAt: true, endsAt: true },
      },
    },
  });
  const uncoveredUpcoming = profile
    ? await findUncoveredUpcoming(
        db,
        consultantProfileId,
        {
          scheduleType: profile.scheduleType,
          weeklyRows: profile.availabilityWindowsWeekly,
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
