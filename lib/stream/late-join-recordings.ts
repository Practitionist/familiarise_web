/**
 * A late joiner sees only the recordings of sessions from their seat on,
 * unless the listing turns on `lateJoinersGetPastRecordings`.
 */

import prisma from "@/lib/prisma";

export interface LateJoinAccess {
  /** Batch id → the viewer's join time, for seats whose listing hides earlier recordings. */
  floors: Map<string, Date>;
}

/** The viewer's late-join floors on class recordings, read once per request. */
export async function lateJoinRecordingAccess(
  userId: string,
): Promise<LateJoinAccess> {
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
  return { floors };
}
