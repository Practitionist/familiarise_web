/**
 * #1819 — a late joiner sees only the recordings of sessions from their seat
 * on, unless the listing turns on `lateJoinersGetPastRecordings`.
 */

import prisma from "@/lib/prisma";

/** Batch id → the viewer's join time, for each class seat whose listing hides earlier recordings. */
export async function lateJoinRecordingFloors(
  userId: string,
): Promise<Map<string, Date>> {
  const seats = await prisma.appointmentParticipant.findMany({
    where: {
      userId,
      role: "CONSULTEE",
      appointment: {
        class: { classPlan: { lateJoinersGetPastRecordings: false } },
      },
    },
    select: {
      createdAt: true,
      payment: { select: { createdAt: true } },
      appointment: { select: { classId: true } },
    },
  });
  const floors = new Map<string, Date>();
  for (const seat of seats) {
    const classId = seat.appointment.classId;
    if (!classId) continue;
    // A re-bought seat reuses its row, so the later of the two is the purchase.
    const paidAt = seat.payment?.createdAt;
    floors.set(
      classId,
      paidAt && paidAt > seat.createdAt ? paidAt : seat.createdAt,
    );
  }
  return floors;
}

/** True when the recording's session started before the viewer's seat in that batch. */
export function hiddenFromLateJoiner(
  recording: {
    meeting?: {
      occurrence?: {
        startsAt: Date;
        appointment?: { classId: string | null } | null;
      } | null;
    } | null;
  },
  floors: Map<string, Date>,
): boolean {
  const occurrence = recording.meeting?.occurrence;
  const classId = occurrence?.appointment?.classId;
  const floor = classId ? floors.get(classId) : undefined;
  return !!floor && !!occurrence && occurrence.startsAt < floor;
}
