// Carries an event's seated learners onto the occurrences an allocation
// writes.

import {
  liveParticipant,
  recordParticipants,
} from "@/lib/booking/participants";
import type { Tx } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { EventType } from "@/utils/scheduling-engine/types";
import { getEventRelationField } from "@/lib/booking/allocation/identity";
import type { AppointmentWithSlots } from "@/lib/booking/allocation/types";

/**
 * Re-seat enrolled users on newly created appointments.
 * Used during in-progress reallocation of group events (classes): when
 * future sessions are deleted and recreated, the learners' participant rows
 * go with the deleted appointments (#1554). This restores them.
 */
export async function reconnectEnrolledUsers(
  tx: Tx,
  appointments: AppointmentWithSlots[],
  enrolledUserIds: string[],
  consultantUserId: string,
  organizationId: string | null | undefined,
): Promise<void> {
  // Filter out the consultant (already seated via createAppointments)
  const userIdsToConnect = enrolledUserIds.filter(
    (id) => id !== consultantUserId,
  );
  if (userIdsToConnect.length === 0) return;

  for (const appointment of appointments) {
    // #1319 A9 — re-linked learners keep their seat; idempotent on retry.
    await recordParticipants(
      tx,
      appointment.id,
      userIdsToConnect.map((userId) => ({
        userId,
        role: "CONSULTEE" as const,
      })),
      // Same org tag as the consultant row createAppointments wrote, so an
      // org-scoped read of the participants never sees a half-tagged seat.
      { status: "CONFIRMED", organizationId },
    );
  }
}

/**
 * #1206 — the people already seated on an event's confirmed sessions.
 *
 * Every delete branch harvests these ids from the rows it frees, so that
 * `reconnectEnrolledUsers` can re-seat them on the replacements. A top-up
 * frees nothing, so it reads them off the surviving appointments instead.
 * Without this a class topped up with two more sessions would create them
 * empty: enrolment for a group event lives ONLY on AppointmentParticipant.
 */
export async function collectEventParticipantIds(
  tx: Tx,
  eventType: EventType,
  eventId: string,
): Promise<string[]> {
  const relationField = getEventRelationField(eventType);
  const seats = await tx.appointmentParticipant.findMany({
    where: {
      // A released seat stays as history; only live seats are carried
      // onto the new sessions.
      ...liveParticipant(),
      appointment: {
        [`${relationField}Id`]: eventId,
        occurrences: { some: { isTentative: false, deletedAt: null } },
      } as Prisma.AppointmentWhereInput,
    },
    select: { userId: true },
  });
  return Array.from(new Set(seats.map((seat) => seat.userId)));
}
