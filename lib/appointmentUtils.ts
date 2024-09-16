import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function checkOverlappingAppointments(
  startTime: Date,
  endTime: Date,
  consultantProfileId: string,
  excludeAppointmentId?: string
): Promise<boolean> {
  const overlappingAppointments = await prisma.slotOfAppointment.findFirst({
    where: {
      AND: [
        {
          OR: [
            {
              slotOfAvailabilityWeekly: {
                consultantProfileId: consultantProfileId,
              },
            },
            {
              slotOfAvailabilityCustom: {
                consultantProfileId: consultantProfileId,
              },
            },
          ],
        },
        {
          OR: [
            // Partial overlaps
            // Start within the range of an existing appointment 
            { 
              appointmentStartTimeInUTC: {
                gte: startTime,
                lt: endTime,
              },
            },

            // End within the range of an existing appointment
            {
              appointmentEndTimeInUTC: {
                gt: startTime,
                lte: endTime,
              },
            },
            // Full overlap
            // Completely encompasses the new appointment
            {
              AND: [
                { appointmentStartTimeInUTC: { lte: startTime } },
                { appointmentEndTimeInUTC: { gte: endTime } },
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