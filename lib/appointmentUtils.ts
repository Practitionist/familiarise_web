import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function checkOverlappingAppointments(
  startTime: Date,
  endTime: Date,
  consultantProfileId: string,
  excludeAppointmentId?: string,
): Promise<boolean> {
  const overlappingAppointments = await prisma.slotOfAppointment.findFirst({
    where: {
      AND: [
        {
          appointment: {
            class: {
              classPlan: {
                consultantProfileId: consultantProfileId,
              },
            },
          },
        },
        {
          OR: [
            // Partial overlaps
            // Start within the range of an existing appointment
            {
              slotStartTimeInUTC: {
                gte: startTime,
                lt: endTime,
              },
            },

            // End within the range of an existing appointment
            {
              slotEndTimeInUTC: {
                gt: startTime,
                lte: endTime,
              },
            },
            // Full overlap
            // Completely encompasses the new appointment
            {
              AND: [
                { slotStartTimeInUTC: { lte: startTime } },
                { slotEndTimeInUTC: { gte: endTime } },
              ],
            },
          ],
        },
        {
          NOT: {
            appointmentId: excludeAppointmentId,
          },
        },
      ],
    },
  });

  return !!overlappingAppointments;
}
