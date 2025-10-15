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
              startsAt: {
                gte: startTime,
                lt: endTime,
              },
            },

            // End within the range of an existing appointment
            {
              endsAt: {
                gt: startTime,
                lte: endTime,
              },
            },
            // Full overlap
            // Completely encompasses the new appointment
            {
              AND: [
                { startsAt: { lte: startTime } },
                { endsAt: { gte: endTime } },
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
