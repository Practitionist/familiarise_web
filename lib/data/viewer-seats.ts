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
