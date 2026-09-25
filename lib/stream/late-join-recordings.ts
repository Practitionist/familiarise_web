/**
 * #1819 — a late joiner sees only the recordings of sessions from their seat
 * on, unless the listing turns on `lateJoinersGetPastRecordings`.
 */

import prisma from "@/lib/prisma";

export interface LateJoinAccess {
  /** Batch id → the viewer's join time, for seats whose listing hides earlier recordings. */
  floors: Map<string, Date>;
  /** Listing id → the viewer's batches, where every seat the viewer holds on it is a late join. */
  lateSeatBatches: Map<string, Set<string>>;
}

/** The viewer's late-join limits on class recordings, read once per request. */
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
      sessionsPurchased: true,
      payment: { select: { createdAt: true } },
      appointment: {
        select: {
          class: {
            select: {
              id: true,
              classPlanId: true,
              classPlan: { select: { totalSessions: true } },
            },
          },
        },
      },
    },
  });
  const floors = new Map<string, Date>();
  const batches = new Map<string, Set<string>>();
  const onTimePlans = new Set<string>();
  for (const seat of seats) {
    const cls = seat.appointment.class;
    if (!cls) continue;
    // A re-bought seat reuses its row, so the later of the two is the purchase.
    const paidAt = seat.payment?.createdAt;
    floors.set(
      cls.id,
      paidAt && paidAt > seat.createdAt ? paidAt : seat.createdAt,
    );
    const late =
      seat.sessionsPurchased !== null &&
      seat.sessionsPurchased < cls.classPlan.totalSessions;
    if (!late) onTimePlans.add(cls.classPlanId);
    batches.set(
      cls.classPlanId,
      (batches.get(cls.classPlanId) ?? new Set<string>()).add(cls.id),
    );
  }
  for (const planId of onTimePlans) batches.delete(planId);
  return { floors, lateSeatBatches: batches };
}

/**
 * True when the recording's session started before the viewer's seat in that
 * batch, or belongs to another batch of a listing the viewer only joined late.
 */
export function hiddenFromLateJoiner(
  recording: {
    meeting?: {
      occurrence?: {
        startsAt: Date;
        appointment?: {
          classId: string | null;
          class?: { classPlanId: string } | null;
        } | null;
      } | null;
    } | null;
  },
  access: LateJoinAccess,
): boolean {
  const occurrence = recording.meeting?.occurrence;
  const classId = occurrence?.appointment?.classId;
  const planId = occurrence?.appointment?.class?.classPlanId;
  const ownBatches = planId ? access.lateSeatBatches.get(planId) : undefined;
  if (classId && ownBatches && !ownBatches.has(classId)) return true;
  const floor = classId ? access.floors.get(classId) : undefined;
  return !!floor && !!occurrence && occurrence.startsAt < floor;
}
