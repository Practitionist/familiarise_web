import { BackupInterestStatus } from "@prisma/client";

import { liveParticipant } from "@/lib/booking/participants";
import prisma from "@/lib/prisma";

/**
 * Which of these appointments the viewer holds a seat on. A plan page is shared
 * across viewers, so "am I enrolled" is read here for the one signed-in viewer
 * and handed down by the server component; it never rides in the plan payload.
 */
export async function viewerSeatAppointmentIds(
  userId: string | null | undefined,
  appointmentIds: readonly string[],
): Promise<string[]> {
  if (!userId || appointmentIds.length === 0) return [];
  const seats = await prisma.appointmentParticipant.findMany({
    where: {
      userId,
      role: "CONSULTEE",
      appointmentId: { in: [...appointmentIds] },
      ...liveParticipant(),
    },
    select: { appointmentId: true },
  });
  return seats.map((seat) => seat.appointmentId);
}

/** Which of these appointments the viewer is on the notify-me list of, read the same way. */
export async function viewerWaitlistAppointmentIds(
  userId: string | null | undefined,
  appointmentIds: readonly string[],
): Promise<string[]> {
  if (!userId || appointmentIds.length === 0) return [];
  const rows = await prisma.appointmentWaitlist.findMany({
    where: {
      userId,
      appointmentId: { in: [...appointmentIds] },
      status: {
        in: [BackupInterestStatus.WAITING, BackupInterestStatus.NOTIFIED],
      },
    },
    select: { appointmentId: true },
  });
  return rows.map((row) => row.appointmentId);
}
