/**
 * The one answer to "may a trial sit at this time": inside the expert's
 * published availability and free on both calendars, read on the caller's
 * transaction so the check and the write commit together. The buyer's pick,
 * the consultant's accept and a trial reschedule all ask it.
 */
import type { Tx } from "@/lib/prisma";
import { consulteeHasOverlappingSession } from "@/lib/payments/checkout/occupancy-validate";
import {
  findUncoveredAtom,
  loadPublishedCoverage,
  windowAtoms,
} from "@/utils/scheduling-engine/availabilityCoverage";
import {
  buildConsultantOccupancyWhere,
  OCCUPYING_OCCURRENCE_WHERE,
} from "@/utils/scheduling-engine/occupancyPolicy";

/** Why a trial time was refused; null means it may be written. */
export type TrialWindowRefusal = "OUTSIDE_AVAILABILITY" | "SLOT_TAKEN";

export interface TrialWindow {
  consultantProfileId: string;
  consultantUserId: string;
  consulteeUserId: string;
  startsAt: Date;
  endsAt: Date;
  /** Appointments whose own rows must not count as a conflict (the trial being moved). */
  selfHoldAppointmentIds: string[];
}

/**
 * Whether both participants are free for the window, under checkout's own
 * predicates: every occupying row the host hosts, attends or co-hosts, and the
 * consultee's calendar including dual-role and lapsed seats.
 */
export async function validateSlotAvailability(
  db: Tx,
  seller: { consultantProfileId: string; userId: string },
  consulteeUserId: string,
  startTime: Date,
  endTime: Date,
  selfHoldAppointmentIds: string[],
): Promise<boolean> {
  const overlapping = await db.appointmentOccurrence.findFirst({
    where: {
      ...OCCUPYING_OCCURRENCE_WHERE,
      ...(selfHoldAppointmentIds.length > 0
        ? { appointmentId: { notIn: selfHoldAppointmentIds } }
        : {}),
      appointment: buildConsultantOccupancyWhere(
        seller.consultantProfileId,
        seller.userId,
        new Date(),
      ),
      startsAt: { lt: endTime },
      endsAt: { gt: startTime },
    },
    select: { id: true },
  });
  if (overlapping) return false;

  return !(await consulteeHasOverlappingSession(db, {
    userId: consulteeUserId,
    startsAt: startTime,
    endsAt: endTime,
    selfHoldAppointmentIds,
  }));
}

/**
 * The published window first (a time never on offer is a 400, not a lost
 * race), then both calendars. Enforced whoever writes the time: a trial is a
 * booking.
 */
export async function trialWindowRefusal(
  db: Tx,
  window: TrialWindow,
): Promise<TrialWindowRefusal | null> {
  const { weeklyRows, customRows } = await loadPublishedCoverage(
    db,
    window.consultantProfileId,
    window.startsAt,
    window.endsAt,
  );
  if (
    findUncoveredAtom(
      windowAtoms(window.startsAt, window.endsAt),
      weeklyRows,
      customRows,
    )
  ) {
    return "OUTSIDE_AVAILABILITY";
  }
  const free = await validateSlotAvailability(
    db,
    {
      consultantProfileId: window.consultantProfileId,
      userId: window.consultantUserId,
    },
    window.consulteeUserId,
    window.startsAt,
    window.endsAt,
    window.selfHoldAppointmentIds,
  );
  return free ? null : "SLOT_TAKEN";
}

/** User copy for each refusal, written for whoever picked the time. */
export const TRIAL_WINDOW_REFUSAL_COPY: Record<TrialWindowRefusal, string> = {
  OUTSIDE_AVAILABILITY:
    "That time isn't in the expert's open hours any more. Pick another time.",
  SLOT_TAKEN: "That time was just taken. Pick another time.",
};

/** HTTP status for each refusal: never on offer is a 400, taken is a 409. */
export const TRIAL_WINDOW_REFUSAL_STATUS: Record<TrialWindowRefusal, number> = {
  OUTSIDE_AVAILABILITY: 400,
  SLOT_TAKEN: 409,
};
