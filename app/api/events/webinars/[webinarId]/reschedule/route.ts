import prisma from "@/lib/prisma";
import { RequestStatus, ScheduleType } from "@prisma/client";
import { addHours, addMinutes } from "date-fns";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  try {
    const { webinarId } = await params;
    const body = await request.json();
    const newStartAt = body?.newStartAt ? new Date(body.newStartAt) : undefined;
    const newEndAt = body?.newEndAt ? new Date(body.newEndAt) : undefined;

    if (!newStartAt) {
      return NextResponse.json(
        { error: "newStartAt is required" },
        { status: 400 },
      );
    }

    if (newStartAt <= new Date()) {
      return NextResponse.json(
        { error: "Cannot reschedule to a past time" },
        { status: 400 },
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      const webinar = await tx.webinar.findUnique({
        where: { id: webinarId },
        include: {
          webinarPlan: {
            include: {
              consultantProfile: {
                select: {
                  user: true,
                  scheduleType: true,
                  slotsOfAvailabilityWeekly: true,
                  slotsOfAvailabilityCustom: true,
                },
              },
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: { include: { user: true } },
            },
          },
        },
      });

      if (!webinar) throw new Error("Webinar not found");

      const consultant = webinar.webinarPlan.consultantProfile;
      if (!consultant?.user?.id)
        throw new Error("Missing consultant information");

      const slots = webinar.appointment?.slotsOfAppointment || [];
      if (slots.length === 0)
        throw new Error("Webinar not scheduled yet. Please schedule first.");

      const durationHours = webinar.webinarPlan.durationInHours || 1;
      const computedEnd = newEndAt || addHours(newStartAt, durationHours);
      if (computedEnd <= newStartAt) {
        throw new Error("End time must be after start time");
      }

      // Validate against consultant availability
      if (consultant.scheduleType === ScheduleType.WEEKLY) {
        const dayNames = [
          "SUNDAY",
          "MONDAY",
          "TUESDAY",
          "WEDNESDAY",
          "THURSDAY",
          "FRIDAY",
          "SATURDAY",
        ] as const;
        const targetDow = dayNames[newStartAt.getUTCDay()];
        const firstMinutesOfDay =
          newStartAt.getUTCHours() * 60 + newStartAt.getUTCMinutes();
        const firstSlotEndMinutes = firstMinutesOfDay + 30;

        // Build ranges (minutes-of-day) for this weekday using UTC time from stored slots
        const ranges = consultant.slotsOfAvailabilityWeekly
          .filter((ws: any) => ws.dayOfWeekforStartTimeInUTC === targetDow)
          .map((ws: any) => {
            const start = new Date(ws.slotStartTimeInUTC);
            const end = new Date(ws.slotEndTimeInUTC);
            return {
              start: start.getUTCHours() * 60 + start.getUTCMinutes(),
              end: end.getUTCHours() * 60 + end.getUTCMinutes(),
            };
          })
          .sort((a: any, b: any) => a.start - b.start);

        const matchesWeekly = ranges.some(
          (r: { start: number; end: number }) =>
            firstMinutesOfDay >= r.start && firstSlotEndMinutes <= r.end,
        );
        if (!matchesWeekly) {
          throw new Error(
            "Selected time does not match consultant's weekly availability",
          );
        }
      } else {
        const matchesCustom = consultant.slotsOfAvailabilityCustom.some(
          (cs: any) =>
            new Date(cs.slotStartTimeInUTC).toISOString() ===
            newStartAt.toISOString(),
        );
        if (!matchesCustom) {
          throw new Error(
            "Selected time is not in consultant's custom availability",
          );
        }
      }

      // Conflict detection across the full chain of 30-min slots
      // FIXED: Calculate slots for the entire webinar duration, not just one call
      const requiredSlots = Math.ceil(durationHours / 0.5);
      const newChainStarts: Date[] = Array.from({ length: requiredSlots }).map(
        (_, i) => addMinutes(newStartAt, i * 30),
      );
      // FIXED: Check for overlapping time ranges instead of just exact start times
      const newStartTime = newStartAt;
      const newEndTime = addMinutes(newStartAt, durationHours * 60);

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
                  AND: [
                    {
                      OR: [
                        // Check for overlapping time ranges
                        {
                          AND: [
                            { slotStartTimeInUTC: { lt: newEndTime } },
                            { slotEndTimeInUTC: { gt: newStartTime } },
                          ],
                        },
                        // Also check for exact start time matches (backward compatibility)
                        { slotStartTimeInUTC: { in: newChainStarts } },
                      ],
                    },
                    {
                      user: { some: { id: consultant.user.id } },
                    },
                  ],
                },
              },
            },
            // CRITICAL FIX: Exclude the current webinar being rescheduled
            {
              NOT: {
                id: webinar.appointment?.id,
              },
            },
          ],
        },
        select: { id: true },
      });

      if (existingAppointments.length > 0) {
        throw new Error(
          "Host has an overlapping event within the new slot chain",
        );
      }

      // Recreate full slot chain at the new time while preserving participant connections
      // 1) Gather all participant IDs (excluding host)
      const hostUserId = consultant.user.id;
      const participantIds = new Set(
        slots.flatMap((s) => s.user.map((u: any) => u.id)),
      );
      participantIds.delete(hostUserId);

      // 2) Delete old slots
      await tx.slotOfAppointment.deleteMany({
        where: { appointmentId: webinar.appointment!.id },
      });

      // 3) Create new chain and reconnect host + participants across all slots
      const createdSlots = [] as any[];
      for (let i = 0; i < requiredSlots; i++) {
        const start = addMinutes(newStartAt, i * 30);
        const end = addMinutes(start, 30);
        const cs = await tx.slotOfAppointment.create({
          data: {
            appointmentId: webinar.appointment!.id,
            slotStartTimeInUTC: start,
            slotEndTimeInUTC: end,
            isTentative: false,
            user: {
              connect: [
                { id: hostUserId },
                ...Array.from(participantIds).map((id) => ({ id })),
              ],
            },
          },
        });
        createdSlots.push(cs);
      }

      const updatedWebinar = await tx.webinar.update({
        where: { id: webinarId },
        data: { status: "SCHEDULED" },
        include: {
          webinarPlan: {
            include: {
              consultantProfile: { include: { user: true } },
              topics: true,
            },
          },
          appointment: {
            include: { slotsOfAppointment: { include: { user: true } } },
          },
          waitlist: true,
        },
      });

      return { updatedWebinar, createdSlots };
    });

    return NextResponse.json({ data: result });
  } catch (error) {
    if (error instanceof Error) {
      console.error("Webinar reschedule error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Failed to reschedule webinar" },
      { status: 500 },
    );
  }
}
