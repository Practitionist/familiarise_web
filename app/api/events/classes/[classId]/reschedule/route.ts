import prisma from "@/lib/prisma";
import { RequestStatus, ScheduleType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  try {
    const { classId } = await params;
    const body = await request.json();
    const { appointmentId, newSlots } = body;

    console.log(
      `🔄 [CLASS RESCHEDULE] Called for classId: ${classId}, appointmentId: ${appointmentId}, slots: ${newSlots.length}`,
    );

    if (!appointmentId || !newSlots || !Array.isArray(newSlots)) {
      return NextResponse.json(
        { error: "appointmentId and newSlots array are required" },
        { status: 400 },
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Get the class with all its details
      const classPlan = await tx.class.findUnique({
        where: { id: classId },
        include: {
          classPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                  slotsOfAvailabilityWeekly: true,
                  slotsOfAvailabilityCustom: true,
                },
              },
              classContents: true,
            },
          },
          appointments: {
            include: {
              slotsOfAppointment: true,
            },
          },
        },
      });

      if (!classPlan) {
        throw new Error("Class not found");
      }

      const { classPlan: classDetails } = classPlan;
      const { consultantProfile } = classDetails;

      if (!consultantProfile?.user?.id) {
        throw new Error("Missing consultant information");
      }

      // 2. Find the specific appointment to reschedule
      const appointmentToReschedule = classPlan.appointments.find(
        (appt) => appt.id === appointmentId,
      );

      if (!appointmentToReschedule) {
        throw new Error("Appointment not found in class");
      }

      // 3. Calculate session duration from class contents
      const classContents = classDetails.classContents || [];
      let sessionDurationInHours = 1; // Default
      if (classContents.length > 0) {
        const totalHours = classContents.reduce(
          (sum, content) => sum + content.hoursAllotted,
          0,
        );
        sessionDurationInHours = totalHours / classContents.length;
      }

      // 4. Calculate slots needed for one session only (not all remaining sessions)
      const slotsPerSession = Math.ceil(sessionDurationInHours / 0.5);

      // 5. For reschedule operations, be more flexible with slot validation
      // Allow rescheduling with different slot counts than the original plan
      console.log(`[Class Reschedule] Slot validation:`, {
        expectedSlotsPerSession: slotsPerSession,
        receivedSlots: newSlots.length,
        sessionDurationHours: sessionDurationInHours,
        isFlexibleReschedule: true,
      });

      // Only validate that we have at least 1 slot for reschedule
      if (newSlots.length < 1) {
        throw new Error(
          `At least 1 slot required for rescheduling, but received ${newSlots.length}`,
        );
      }

      // 6. Validate all new slots are in the future
      const now = new Date();
      for (const slotTime of newSlots) {
        const slotDate = new Date(slotTime);
        if (slotDate <= now) {
          throw new Error("Cannot reschedule to a past time");
        }
      }

      // 7. Validate slots are within consultant's availability
      if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
        // Validate weekly availability
        for (const slotTime of newSlots) {
          const slotDate = new Date(slotTime);
          const dayNames = [
            "SUNDAY",
            "MONDAY",
            "TUESDAY",
            "WEDNESDAY",
            "THURSDAY",
            "FRIDAY",
            "SATURDAY",
          ] as const;
          const targetDow = dayNames[slotDate.getUTCDay()];
          const minutesOfDay =
            slotDate.getUTCHours() * 60 + slotDate.getUTCMinutes();

          const ranges = consultantProfile.slotsOfAvailabilityWeekly
            .filter((ws: any) => ws.dayOfWeekforStartTimeInUTC === targetDow)
            .map((ws: any) => {
              const start = new Date(ws.slotStartTimeInUTC);
              const end = new Date(ws.slotEndTimeInUTC);
              return {
                start: start.getUTCHours() * 60 + start.getUTCMinutes(),
                end: end.getUTCHours() * 60 + end.getUTCMinutes(),
              };
            });

          const withinRange = ranges.some(
            (r) => minutesOfDay >= r.start && minutesOfDay + 30 <= r.end,
          );

          if (!withinRange) {
            throw new Error(
              `Selected time ${slotDate.toISOString()} does not match consultant's weekly availability`,
            );
          }
        }
      } else {
        // Validate custom availability
        for (const slotTime of newSlots) {
          const slotDate = new Date(slotTime);
          const matchesCustom =
            consultantProfile.slotsOfAvailabilityCustom.some((cs: any) => {
              const customSlotStart = new Date(cs.slotStartTimeInUTC);
              const customSlotEnd = new Date(cs.slotEndTimeInUTC);
              return slotDate >= customSlotStart && slotDate < customSlotEnd;
            });

          if (!matchesCustom) {
            throw new Error(
              `Selected time ${slotDate.toISOString()} is not in consultant's custom availability`,
            );
          }
        }
      }

      // 8. Check for conflicts with other appointments
      const existingAppointments = await tx.appointment.findMany({
        where: {
          AND: [
            {
              OR: [
                { subscription: { requestStatus: RequestStatus.APPROVED } },
                { consultation: { requestStatus: RequestStatus.APPROVED } },
                { webinar: { status: "SCHEDULED" } },
                { class: { status: "SCHEDULED" } },
              ],
            },
            {
              slotsOfAppointment: {
                some: {
                  slotStartTimeInUTC: { in: newSlots },
                  user: { some: { id: consultantProfile.user.id } },
                },
              },
            },
            // Exclude the current appointment being rescheduled
            {
              NOT: {
                id: appointmentToReschedule.id,
              },
            },
          ],
        },
        select: { id: true },
      });

      if (existingAppointments.length > 0) {
        throw new Error(
          "Consultant has overlapping events within the new slot times",
        );
      }

      // 9. Validate weekly limits for the new slots
      if (classPlan.classPlan.callsPerWeek) {
        // Calculate session duration from class contents (same logic as validate route)
        const classContents = classPlan.classPlan.classContents || [];
        let sessionDurationInHours = 1; // Default
        if (classContents.length > 0) {
          const totalHours = classContents.reduce(
            (sum, content) => sum + content.hoursAllotted,
            0,
          );
          sessionDurationInHours = totalHours / classContents.length;
        }

        const slotsPerSession = Math.ceil(sessionDurationInHours / 0.5); // 30-min slots
        const maxSlotsPerWeek =
          classPlan.classPlan.callsPerWeek * slotsPerSession;

        // Get all existing class slots (excluding the appointment being rescheduled)
        const existingClassSlots = await tx.appointment.findMany({
          where: {
            AND: [
              { class: { status: "SCHEDULED" } },
              { classId: classId },
              { NOT: { id: appointmentToReschedule.id } }, // Exclude current appointment
            ],
          },
          include: {
            slotsOfAppointment: true,
          },
        });

        const existingSlotDates = existingClassSlots.flatMap((app) =>
          app.slotsOfAppointment.map(
            (slot) => new Date(slot.slotStartTimeInUTC),
          ),
        );

        // Combine existing slots with new proposed slots
        const allSlots = [
          ...existingSlotDates,
          ...newSlots.map((slot) => new Date(slot)),
        ];

        // Validate weekly distribution
        const slotsByWeek = new Map<string, number>();
        for (const slotDate of allSlots) {
          const weekStart = new Date(slotDate);
          weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Get start of week (Sunday)
          weekStart.setHours(0, 0, 0, 0); // Set to start of day
          const weekKey = weekStart.toISOString();
          slotsByWeek.set(weekKey, (slotsByWeek.get(weekKey) || 0) + 1);
        }

        for (const [weekKey, count] of Array.from(slotsByWeek.entries())) {
          if (count > maxSlotsPerWeek) {
            const weekDate = new Date(weekKey);
            throw new Error(
              `Rescheduling would exceed weekly limit. Week of ${weekDate.toLocaleDateString()} would have ${count} slots but maximum allowed is ${maxSlotsPerWeek} (${classPlan.classPlan.callsPerWeek} sessions × ${slotsPerSession} slots per session)`,
            );
          }
        }
      }

      // 10. Delete old slots for the appointment being rescheduled
      await tx.slotOfAppointment.deleteMany({
        where: { appointmentId: appointmentToReschedule.id },
      });

      // 11. Create new slots for the rescheduled appointment
      const createdSlots = [];
      for (const slotTime of newSlots) {
        const slotDate = new Date(slotTime);
        const slotEnd = new Date(slotDate.getTime() + 30 * 60 * 1000); // 30 minutes

        const newSlot = await tx.slotOfAppointment.create({
          data: {
            appointmentId: appointmentToReschedule.id,
            slotStartTimeInUTC: slotDate,
            slotEndTimeInUTC: slotEnd,
            isTentative: false,
            user: {
              connect: [
                { id: consultantProfile.user.id },
                // Add participants if available
              ],
            },
          },
        });
        createdSlots.push(newSlot);
      }

      // 12. Update the appointment
      const updatedAppointment = await tx.appointment.update({
        where: { id: appointmentToReschedule.id },
        data: {},
        include: {
          slotsOfAppointment: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
            },
          },
        },
      });

      return {
        updatedAppointment,
        createdSlots,
        sessionDurationInHours,
      };
    });

    return NextResponse.json({ data: result });
  } catch (error) {
    if (error instanceof Error) {
      console.error("Class reschedule error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Failed to reschedule class appointment" },
      { status: 500 },
    );
  }
}
