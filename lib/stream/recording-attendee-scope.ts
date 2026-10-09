/**
 * Which recordings an attendee may see. Webinar attendees see only the run
 * they paid for or held a seat in, unless the plan shares recordings across
 * runs; class members see every batch of the plan (late-join limits apply
 * separately); 1:1 sessions stay per appointment.
 */

import type { Prisma } from "@prisma/client";

export interface AttendeeScopeAppointment {
  id: string;
  webinar?: {
    webinarPlan?: {
      id: string;
      shareRecordingsWithAllAttendees: boolean;
    } | null;
  } | null;
  class?: { classPlan?: { id: string } | null } | null;
}

/** Appointments whose payment or live seat entitles the caller to this appointment's recordings. */
export function attendeeEntitlementFilter(
  appointment: AttendeeScopeAppointment,
): Prisma.AppointmentWhereInput {
  const webinarPlan = appointment.webinar?.webinarPlan;
  if (webinarPlan) {
    return webinarPlan.shareRecordingsWithAllAttendees
      ? { webinar: { webinarPlanId: webinarPlan.id } }
      : { id: appointment.id };
  }
  const classPlan = appointment.class?.classPlan;
  if (classPlan) return { class: { classPlanId: classPlan.id } };
  return { id: appointment.id };
}

export interface WebinarEntitlement {
  appointmentId: string;
  webinarPlanId: string;
  shareRecordingsWithAllAttendees: boolean;
}

export interface WebinarRecordingScope {
  /** Plans whose every run's recordings the caller may see. */
  sharedPlanIds: string[];
  /** Runs the caller paid for or held a seat in. */
  appointmentIds: string[];
}

export function webinarRecordingScope(
  entitlements: WebinarEntitlement[],
): WebinarRecordingScope {
  return {
    sharedPlanIds: [
      ...new Set(
        entitlements
          .filter((e) => e.shareRecordingsWithAllAttendees)
          .map((e) => e.webinarPlanId),
      ),
    ],
    appointmentIds: [...new Set(entitlements.map((e) => e.appointmentId))],
  };
}

export function webinarRecordingVisible(
  recording: { appointmentId: string; webinarPlanId: string },
  scope: WebinarRecordingScope,
): boolean {
  return (
    scope.appointmentIds.includes(recording.appointmentId) ||
    scope.sharedPlanIds.includes(recording.webinarPlanId)
  );
}

/** {@link webinarRecordingVisible} as a Recording filter. */
export function webinarRecordingWhere(
  scope: WebinarRecordingScope,
): Prisma.RecordingWhereInput[] {
  const arms: Prisma.RecordingWhereInput[] = [];
  if (scope.appointmentIds.length > 0) {
    arms.push({
      meeting: {
        occurrence: {
          appointment: {
            id: { in: scope.appointmentIds },
            webinar: { isNot: null },
          },
        },
      },
    });
  }
  if (scope.sharedPlanIds.length > 0) {
    arms.push({
      meeting: {
        occurrence: {
          appointment: {
            webinar: { webinarPlanId: { in: scope.sharedPlanIds } },
          },
        },
      },
    });
  }
  return arms;
}
