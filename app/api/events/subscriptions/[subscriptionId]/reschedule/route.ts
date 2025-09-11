import prisma from "@/lib/prisma";
import { RequestStatus, ScheduleType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> }
) {
  try {
    const { subscriptionId } = await params;
    const body = await request.json();
    const { appointmentId, newSlots, callTimestamp } = body;

    if (!appointmentId || !newSlots || !Array.isArray(newSlots)) {
      return NextResponse.json(
        { error: "appointmentId and newSlots array are required" },
        { status: 400 }
      );
    }

    console.log(`[Reschedule] Request params:`, {
      subscriptionId,
      appointmentId,
      callTimestamp,
      newSlotsCount: newSlots.length,
    });

    const result = await prisma.$transaction(async (tx) => {
      // 1. Get the subscription with all its details
      const subscription = await tx.subscription.findUnique({
        where: { id: subscriptionId },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                  slotsOfAvailabilityWeekly: true,
                  slotsOfAvailabilityCustom: true,
                },
              },
            },
          },
          requestedBy: {
            include: {
              user: true,
            },
          },
          appointments: {
            include: {
              slotsOfAppointment: true,
            },
          },
        },
      });

      if (!subscription) {
        throw new Error("Subscription not found");
      }

      const { subscriptionPlan, requestedBy } = subscription;
      const { consultantProfile } = subscriptionPlan;

      if (!consultantProfile?.user?.id) {
        throw new Error("Missing consultant information");
      }

      // 2. Find the specific appointment to reschedule
      console.log(
        `[Reschedule] Looking for appointment ${appointmentId} in subscription ${subscriptionId}`
      );
      console.log(
        `[Reschedule] Available appointments:`,
        subscription.appointments.map((a) => ({
          id: a.id,
          type: a.appointmentType,
        }))
      );

      const appointmentToReschedule = subscription.appointments.find(
        (appt) => appt.id === appointmentId
      );

      if (!appointmentToReschedule) {
        console.error(
          `[Reschedule] Appointment ${appointmentId} not found in subscription ${subscriptionId}`
        );
        console.error(
          `[Reschedule] Available appointment IDs:`,
          subscription.appointments.map((a) => a.id)
        );
        throw new Error("Appointment not found in subscription");
      }

      console.log(`[Reschedule] Found appointment to reschedule:`, {
        id: appointmentToReschedule.id,
        type: appointmentToReschedule.appointmentType,
        currentSlots: appointmentToReschedule.slotsOfAppointment.length,
      });

      // 3. Calculate slots per call for validation
      const slotsPerCall = Math.ceil(
        subscriptionPlan.sessionDurationInHours / 0.5
      );

      // 4. For reschedule operations, be more flexible with slot validation
      // Allow rescheduling with different slot counts than the original plan
      // This handles cases where users want to reschedule with fewer slots or adjust duration
      console.log(`[Reschedule] Slot validation:`, {
        expectedSlotsPerCall: slotsPerCall,
        receivedSlots: newSlots.length,
        sessionDurationHours: subscriptionPlan.sessionDurationInHours,
        isFlexibleReschedule: true,
      });

      // Only validate that we have at least 1 slot for reschedule
      if (newSlots.length < 1) {
        throw new Error(
          `At least 1 slot required for rescheduling, but received ${newSlots.length}`
        );
      }

      // 5. Find the specific call to reschedule if callTimestamp is provided
      let oldCallSlots: any[] = [];
      if (callTimestamp) {
        const callTime = new Date(callTimestamp);
        console.log(
          `[Reschedule] Looking for call at timestamp: ${callTime.toISOString()}`
        );

        // Find slots that start at or around the call timestamp
        oldCallSlots = appointmentToReschedule.slotsOfAppointment.filter(
          (slot: any) => {
            const slotTime = new Date(slot.slotStartTimeInUTC);
            // Allow some tolerance (within the same hour)
            const timeDiff = Math.abs(slotTime.getTime() - callTime.getTime());
            return timeDiff < 60 * 60 * 1000; // 1 hour tolerance
          }
        );

        console.log(
          `[Reschedule] Found ${oldCallSlots.length} slots for call at ${callTime.toISOString()}`
        );

        if (oldCallSlots.length === 0) {
          throw new Error(
            `Could not find call at timestamp ${callTimestamp} in appointment`
          );
        }
      } else {
        // If no specific call timestamp, reschedule all slots (original behavior)
        oldCallSlots = appointmentToReschedule.slotsOfAppointment;
        console.log(
          `[Reschedule] No call timestamp provided, rescheduling entire appointment (${oldCallSlots.length} slots)`
        );
      }

      // 7. Validate all new slots are in the future
      const now = new Date();
      for (const slotTime of newSlots) {
        const slotDate = new Date(slotTime);
        if (slotDate <= now) {
          throw new Error("Cannot reschedule to a past time");
        }
      }

      // 8. Validate slots are within subscription period
      for (const slotTime of newSlots) {
        const slotDate = new Date(slotTime);
        if (
          slotDate < subscription.startDate ||
          slotDate > subscription.endDate
        ) {
          throw new Error(
            `Selected time ${slotDate.toISOString()} is outside subscription period (${subscription.startDate.toISOString()} - ${subscription.endDate.toISOString()})`
          );
        }
      }

      // 8.5. Validate slots are consecutive and form complete calls
      const sortedNewSlots = [...newSlots].sort(
        (a, b) => new Date(a).getTime() - new Date(b).getTime()
      );

      // Group slots by day to ensure they're consecutive within each day
      const slotsByDay = new Map<string, Date[]>();
      for (const slotTime of sortedNewSlots) {
        const slotDate = new Date(slotTime);
        const dayKey = slotDate.toDateString();
        if (!slotsByDay.has(dayKey)) {
          slotsByDay.set(dayKey, []);
        }
        slotsByDay.get(dayKey)!.push(slotDate);
      }

      // Check each day has consecutive slots and forms complete calls
      for (const [dayKey, daySlots] of slotsByDay.entries()) {
        const sortedDaySlots = daySlots.sort(
          (a, b) => a.getTime() - b.getTime()
        );

        // Check if slots are consecutive (30-minute intervals)
        for (let i = 1; i < sortedDaySlots.length; i++) {
          const prevSlot = sortedDaySlots[i - 1];
          const currentSlot = sortedDaySlots[i];
          const expectedNext = new Date(prevSlot.getTime() + 30 * 60 * 1000);

          if (currentSlot.getTime() !== expectedNext.getTime()) {
            throw new Error(
              `Slots must be consecutive. Gap found between ${prevSlot.toISOString()} and ${currentSlot.toISOString()}`
            );
          }
        }

        // Check if day slots form complete calls
        if (daySlots.length % slotsPerCall !== 0) {
          throw new Error(
            `Each day must contain complete calls of ${slotsPerCall} slots. Day ${dayKey} has ${daySlots.length} slots.`
          );
        }
      }

      // 9. Validate slots are within consultant's availability
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
            (r) => minutesOfDay >= r.start && minutesOfDay + 30 <= r.end
          );

          if (!withinRange) {
            throw new Error(
              `Selected time ${slotDate.toISOString()} does not match consultant's weekly availability`
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
              `Selected time ${slotDate.toISOString()} is not in consultant's custom availability`
            );
          }
        }
      }

      // 10. Check for conflicts with other appointments
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
          "Consultant has overlapping events within the new slot times"
        );
      }

      // 11. Delete only the specific call's slots (not all appointment slots)
      const oldSlotIds = oldCallSlots.map((slot: any) => slot.id);
      console.log(
        `[Reschedule] Deleting ${oldSlotIds.length} old call slots:`,
        oldSlotIds
      );

      await tx.slotOfAppointment.deleteMany({
        where: {
          id: { in: oldSlotIds },
        },
      });

      // 12. Create new slots for the rescheduled appointment
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
                { id: requestedBy.user.id },
              ],
            },
          },
        });
        createdSlots.push(newSlot);
      }

      // 13. Update the appointment
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
        originalSlotCount: oldCallSlots.length,
        newSlotCount: newSlots.length,
      };
    });

    return NextResponse.json({ data: result });
  } catch (error) {
    if (error instanceof Error) {
      console.error("Subscription reschedule error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Failed to reschedule subscription appointment" },
      { status: 500 }
    );
  }
}
