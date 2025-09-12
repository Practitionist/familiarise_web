import prisma from "@/lib/prisma";
import {
  AppointmentsType,
  Prisma,
  RequestStatus,
  ScheduleType,
} from "@prisma/client";
import { addMinutes } from "date-fns";
import { NextRequest, NextResponse } from "next/server";
import {
  getSlotBookingStatus,
  hasTimeOverlap,
} from "@/utils/timeSlotsProcessing";

type PrismaTransaction = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use"
>;

interface AllocationRequest {
  isAuto: boolean;
  slots?: string[]; // For manual allocation: full chain of 30-min slot starts
  useRequestedSlots?: boolean; // For using pre-allocated/requested slot
}

const webinarInclude = {
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
      slotsOfAppointment: true,
    },
  },
} as const;

type WebinarWithRelations = Prisma.WebinarGetPayload<{
  include: typeof webinarInclude;
}>;

async function allocateSlotAuto(
  webinar: WebinarWithRelations,
  tx: PrismaTransaction,
): Promise<Date> {
  const { webinarPlan } = webinar;
  const { consultantProfile } = webinarPlan;

  if (!consultantProfile) {
    throw new Error("Consultant profile not found");
  }

  // Calculate required slots for the webinar duration
  const requiredSlots = Math.ceil(webinarPlan.durationInHours / 0.5); // 30-minute intervals

  // Get available slots based on schedule type
  const availableSlots =
    consultantProfile.scheduleType === ScheduleType.WEEKLY
      ? consultantProfile.slotsOfAvailabilityWeekly
      : consultantProfile.slotsOfAvailabilityCustom;

  if (!availableSlots.length) {
    throw new Error("No available slots found for consultant");
  }

  // Sort slots by time of day to prioritize earlier slots
  const sortedSlots = [...availableSlots].sort((a, b) => {
    const timeA = new Date(a.slotStartTimeInUTC).getHours();
    const timeB = new Date(b.slotStartTimeInUTC).getHours();
    return timeA - timeB;
  });

  // Get all existing appointments to check for conflicts
  const existingAppointments = await tx.appointment.findMany({
    where: {
      AND: [
        {
          OR: [
            {
              subscription: {
                requestStatus: RequestStatus.APPROVED,
              },
            },
            {
              consultation: {
                requestStatus: RequestStatus.APPROVED,
              },
            },
            {
              webinar: {
                status: "SCHEDULED",
              },
            },
            {
              class: {
                status: "SCHEDULED",
              },
            },
          ],
        },
        {
          slotsOfAppointment: {
            some: {
              user: {
                some: {
                  id: consultantProfile.user.id,
                },
              },
            },
          },
        },
        // CRITICAL FIX: Exclude the current webinar being allocated from conflict check
        {
          NOT: {
            webinar: {
              id: webinar.id,
            },
          },
        },
      ],
    },
    include: {
      slotsOfAppointment: true,
    },
  });

  // Get booked time slots
  const bookedSlots = new Set(
    existingAppointments.flatMap((app) =>
      app.slotsOfAppointment.map((slot: { slotStartTimeInUTC: Date }) =>
        slot.slotStartTimeInUTC.toISOString(),
      ),
    ),
  );

  // Generate candidate slots from availability
  const candidateSlots: Date[] = [];
  const now = new Date();

  if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
    // For weekly schedule, project weekly patterns from today onward
    for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
      // Look ahead 30 days
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + dayOffset);

      for (const weeklySlot of sortedSlots) {
        const slotDay = new Date(weeklySlot.slotStartTimeInUTC).getDay();
        if (targetDate.getDay() === slotDay) {
          const candidateSlot = new Date(targetDate);
          candidateSlot.setHours(
            new Date(weeklySlot.slotStartTimeInUTC).getHours(),
            new Date(weeklySlot.slotStartTimeInUTC).getMinutes(),
            0,
            0,
          );

          if (candidateSlot >= now) {
            candidateSlots.push(candidateSlot);
          }
        }
      }
    }
  } else {
    // For custom schedule, use exact custom slots on/after today
    for (const customSlot of sortedSlots) {
      const slotDate = new Date(customSlot.slotStartTimeInUTC);
      if (slotDate >= now) {
        candidateSlots.push(slotDate);
      }
    }
  }

  // Sort candidate slots chronologically
  candidateSlots.sort((a, b) => a.getTime() - b.getTime());

  // Create a Set for fast lookup of candidate slot times
  const candidateSlotSet = new Set(
    candidateSlots.map((slot) => slot.toISOString()),
  );

  // Find the earliest consecutive block that fits the webinar duration
  for (const firstSlot of candidateSlots) {
    // Skip if first slot is already booked
    if (bookedSlots.has(firstSlot.toISOString())) {
      continue;
    }

    // Check if we have enough consecutive slots starting from this time
    const consecutiveSlots: Date[] = [];
    let currentSlotTime = new Date(firstSlot);

    for (let i = 0; i < requiredSlots; i++) {
      const slotTime = new Date(currentSlotTime);

      // Skip if this slot is already booked or in the past
      const slotISO = slotTime.toISOString();
      if (
        !candidateSlotSet.has(slotISO) ||
        bookedSlots.has(slotISO) ||
        slotTime < now
      ) {
        break;
      }

      // Validate this slot is on the same day as the first slot
      if (slotTime.toDateString() !== firstSlot.toDateString()) {
        break;
      }

      consecutiveSlots.push(slotTime);

      // Calculate next slot time
      const nextSlotTime = new Date(slotTime.getTime() + 30 * 60 * 1000);
      currentSlotTime = nextSlotTime;
    }

    // If we found enough consecutive slots on the same day, return the first slot
    if (consecutiveSlots.length === requiredSlots) {
      return firstSlot;
    }
  }

  throw new Error("No available consecutive slots found for webinar duration");
}

async function allocateSlotRequested(
  webinar: WebinarWithRelations,
  tx: PrismaTransaction,
): Promise<Date> {
  // Get the requested slot from the appointment
  const requestedSlot =
    webinar.appointment?.slotsOfAppointment?.[0]?.slotStartTimeInUTC;
  if (!requestedSlot) {
    throw new Error("No requested slot found");
  }
  const selectedSlot = new Date(requestedSlot);

  // Validate the slot is still available
  const hostUserId = webinar.webinarPlan?.consultantProfile?.user?.id;
  if (!hostUserId) {
    throw new Error("Missing consultant user information");
  }

  const existingAppointment = await tx.appointment.findFirst({
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
            some: { slotStartTimeInUTC: selectedSlot },
          },
        },
        // Scope conflicts to appointments involving the same consultant (host)
        {
          slotsOfAppointment: {
            some: {
              user: {
                some: { id: hostUserId },
              },
            },
          },
        },
        // CRITICAL FIX: Exclude the current webinar being allocated from conflict check
        {
          NOT: {
            webinar: {
              id: webinar.id,
            },
          },
        },
      ],
    },
  });

  if (existingAppointment) {
    throw new Error("Requested slot is no longer available");
  }

  return selectedSlot;
}

async function allocateSlotManual(
  webinar: WebinarWithRelations,
  slots: string[],
  tx: PrismaTransaction,
): Promise<Date[]> {
  const { webinarPlan } = webinar;
  const { consultantProfile } = webinarPlan;

  if (!consultantProfile) {
    throw new Error("Consultant profile not found");
  }

  // Convert and sort unique slot starts
  const selected = Array.from(
    new Set(slots.map((s) => new Date(s).toISOString())),
  )
    .map((s) => new Date(s))
    .sort((a, b) => a.getTime() - b.getTime());

  const requiredSlots = Math.ceil(webinarPlan.durationInHours / 0.5);

  if (selected.length !== requiredSlots) {
    throw new Error(
      `Webinar requires exactly ${requiredSlots} slots for ${webinarPlan.durationInHours} hour(s)`,
    );
  }

  // Validate slot is in the future
  const now = new Date();
  for (const d of selected) {
    if (d <= now) throw new Error("Cannot allocate slots in the past");
  }

  // Validate slots are same-day and consecutive 30-min increments
  const firstDay = selected[0].toDateString();
  const allSameDay = selected.every((d) => d.toDateString() === firstDay);
  if (!allSameDay) {
    throw new Error("Webinar slots must be on the same day");
  }
  for (let i = 1; i < selected.length; i++) {
    const prev = selected[i - 1];
    const cur = selected[i];
    if (cur.getTime() !== prev.getTime() + 30 * 60 * 1000) {
      throw new Error("Webinar slots must be consecutive 30-min intervals");
    }
  }

  // Validate first slot matches consultant's schedule type
  const slotDate = selected[0];
  if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
    // For weekly schedule, validate entire webinar block (all selected slots) fits within
    // merged availability windows for that weekday. This supports durations > 1 hour and
    // contiguous windows.
    const requestedDayOfWeek = slotDate.getUTCDay();
    const weekly = consultantProfile.slotsOfAvailabilityWeekly.filter(
      (ws: any) => {
        const dayMap: Record<string, number> = {
          SUNDAY: 0,
          MONDAY: 1,
          TUESDAY: 2,
          WEDNESDAY: 3,
          THURSDAY: 4,
          FRIDAY: 5,
          SATURDAY: 6,
        };
        return dayMap[ws.dayOfWeekforStartTimeInUTC] === requestedDayOfWeek;
      },
    );

    if (weekly.length === 0) {
      const dayNames = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];
      throw new Error(
        `Selected time is on ${dayNames[requestedDayOfWeek]}, but consultant has no availability on ${dayNames[requestedDayOfWeek]}s.`,
      );
    }

    const blockStartMin =
      selected[0].getUTCHours() * 60 + selected[0].getUTCMinutes();
    const blockEndMin =
      selected[selected.length - 1].getUTCHours() * 60 +
      selected[selected.length - 1].getUTCMinutes() +
      30; // include last 30-min slot

    // Build and merge ranges for that weekday
    const ranges = weekly
      .map((ws: any) => {
        const s = new Date(ws.slotStartTimeInUTC);
        const e = new Date(ws.slotEndTimeInUTC);
        return {
          start: s.getUTCHours() * 60 + s.getUTCMinutes(),
          end: e.getUTCHours() * 60 + e.getUTCMinutes(),
        };
      })
      .sort((a: any, b: any) => a.start - b.start);

    const merged: Array<{ start: number; end: number }> = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (!last) merged.push({ ...r });
      else if (r.start <= last.end) last.end = Math.max(last.end, r.end);
      else merged.push({ ...r });
    }

    const fits = merged.some(
      (r) => blockStartMin >= r.start && blockEndMin <= r.end,
    );
    if (!fits) {
      const dayNames = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];
      const availableWindows = merged
        .map((r) => {
          const h1 = String(Math.floor(r.start / 60)).padStart(2, "0");
          const m1 = String(r.start % 60).padStart(2, "0");
          const h2 = String(Math.floor(r.end / 60)).padStart(2, "0");
          const m2 = String(r.end % 60).padStart(2, "0");
          return `${h1}:${m1}-${h2}:${m2}`;
        })
        .join(", ");
      throw new Error(
        `Selected time ${slotDate.toISOString()} is outside consultant's available windows on ${dayNames[requestedDayOfWeek]}s. Available windows: ${availableWindows} UTC.`,
      );
    }
  } else {
    // For custom schedule, validate slot exists in custom slots
    const availableFirst = consultantProfile.slotsOfAvailabilityCustom.some(
      (slot) =>
        new Date(slot.slotStartTimeInUTC).toISOString() ===
        slotDate.toISOString(),
    );
    if (!availableFirst) {
      throw new Error(
        `Slot ${slotDate.toLocaleString()} is not in consultant's custom schedule`,
      );
    }
  }

  // Check for conflicts using the same logic as availability API
  // Get all existing appointments that could overlap with selected slots
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
              // Find appointments that overlap with any of our selected time ranges
              OR: selected.flatMap((slotStart) => {
                const slotEnd = addMinutes(slotStart, 30); // 30-minute slots
                return [
                  // Overlap conditions: start1 < end2 && start2 < end1
                  {
                    AND: [
                      { slotStartTimeInUTC: { lte: slotStart } },
                      { slotEndTimeInUTC: { gt: slotStart } },
                    ],
                  },
                  {
                    AND: [
                      { slotStartTimeInUTC: { lt: slotEnd } },
                      { slotEndTimeInUTC: { gte: slotEnd } },
                    ],
                  },
                  {
                    AND: [
                      { slotStartTimeInUTC: { gte: slotStart } },
                      { slotEndTimeInUTC: { lte: slotEnd } },
                    ],
                  },
                ];
              }),
            },
          },
        },
        // Scope conflicts to appointments involving the same consultant (host)
        {
          slotsOfAppointment: {
            some: {
              user: {
                some: {
                  id: consultantProfile.user.id,
                },
              },
            },
          },
        },
        // CRITICAL FIX: Exclude the current webinar being allocated from conflict check
        {
          NOT: {
            webinar: {
              id: webinar.id,
            },
          },
        },
      ],
    },
    include: {
      slotsOfAppointment: true,
    },
  });

  // Check each selected slot for conflicts using the same logic as availability API
  for (const selectedSlot of selected) {
    const slotStart = selectedSlot;
    const slotEnd = addMinutes(selectedSlot, 30);

    // Get all appointment slots that overlap with this specific slot
    const overlappingSlots: Array<{
      slotStartTimeInUTC: Date;
      slotEndTimeInUTC: Date;
    }> = [];
    existingAppointments.forEach((appointment) => {
      appointment.slotsOfAppointment.forEach((slot) => {
        if (
          hasTimeOverlap(
            slotStart,
            slotEnd,
            slot.slotStartTimeInUTC,
            slot.slotEndTimeInUTC,
          )
        ) {
          overlappingSlots.push(slot);
        }
      });
    });

    // Use the same booking status logic as availability API
    const bookingStatus = getSlotBookingStatus(
      slotStart,
      slotEnd,
      overlappingSlots.map((slot) => ({
        slotStartTimeInUTC: slot.slotStartTimeInUTC,
        slotEndTimeInUTC: slot.slotEndTimeInUTC,
      })),
    );

    // Only reject if slot is fully booked (same threshold as availability API)
    if (bookingStatus === "fully-booked") {
      throw new Error("One or more selected slots are already fully booked");
    }
  }

  return selected;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  try {
    const { webinarId } = await params;
    const body: AllocationRequest = await request.json();

    // Validate request body
    if (typeof body.isAuto !== "boolean") {
      return NextResponse.json(
        { error: "isAuto flag is required" },
        { status: 400 },
      );
    }

    if (body.useRequestedSlots) {
      // When using requested slots, we don't need manual slots
      body.isAuto = false;
    } else if (!body.isAuto && !Array.isArray(body.slots)) {
      return NextResponse.json(
        { error: "slots array is required for manual allocation" },
        { status: 400 },
      );
    }

    // Fetch webinar with necessary relations
    const webinar = await prisma.webinar.findUnique({
      where: { id: webinarId },
      include: webinarInclude,
    });

    if (!webinar) {
      return NextResponse.json({ error: "Webinar not found" }, { status: 404 });
    }

    // Validate user information
    if (!webinar.webinarPlan?.consultantProfile?.user?.id) {
      return NextResponse.json(
        { error: "Missing consultant information" },
        { status: 400 },
      );
    }

    const { consultantProfile } = webinar.webinarPlan;
    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 400 },
      );
    }

    try {
      // Use transaction to ensure atomic updates
      const result = await prisma.$transaction(async (tx) => {
        // If using requested slots and appointment exists, just update status
        if (body.useRequestedSlots && webinar.appointment) {
          // Validate the slot is still available using overlap logic
          const requestedSlot = webinar.appointment.slotsOfAppointment[0];
          const slotStart = requestedSlot.slotStartTimeInUTC;
          const slotEnd = requestedSlot.slotEndTimeInUTC;
          const hostUserId = webinar.webinarPlan?.consultantProfile?.user?.id;
          if (!hostUserId) {
            throw new Error("Missing consultant user information");
          }

          const conflictingAppointments = await tx.appointment.findMany({
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
                      // Check for overlaps using the same logic as availability API
                      OR: [
                        {
                          AND: [
                            { slotStartTimeInUTC: { lte: slotStart } },
                            { slotEndTimeInUTC: { gt: slotStart } },
                          ],
                        },
                        {
                          AND: [
                            { slotStartTimeInUTC: { lt: slotEnd } },
                            { slotEndTimeInUTC: { gte: slotEnd } },
                          ],
                        },
                        {
                          AND: [
                            { slotStartTimeInUTC: { gte: slotStart } },
                            { slotEndTimeInUTC: { lte: slotEnd } },
                          ],
                        },
                      ],
                    },
                  },
                },
                // Scope conflicts to appointments involving the same consultant (host)
                {
                  slotsOfAppointment: {
                    some: {
                      user: {
                        some: {
                          id: hostUserId,
                        },
                      },
                    },
                  },
                },
                // CRITICAL FIX: Exclude the current webinar being allocated from conflict check
                {
                  NOT: {
                    id: webinar.appointment?.id,
                  },
                },
              ],
            },
            include: {
              slotsOfAppointment: true,
            },
          });

          // Check if any conflicting appointments make this slot fully booked
          const overlappingSlots: Array<{
            slotStartTimeInUTC: Date;
            slotEndTimeInUTC: Date;
          }> = [];
          conflictingAppointments.forEach((appointment) => {
            appointment.slotsOfAppointment.forEach((slot) => {
              if (
                hasTimeOverlap(
                  slotStart,
                  slotEnd,
                  slot.slotStartTimeInUTC,
                  slot.slotEndTimeInUTC,
                )
              ) {
                overlappingSlots.push(slot);
              }
            });
          });

          const bookingStatus = getSlotBookingStatus(
            slotStart,
            slotEnd,
            overlappingSlots.map((slot) => ({
              slotStartTimeInUTC: slot.slotStartTimeInUTC,
              slotEndTimeInUTC: slot.slotEndTimeInUTC,
            })),
          );

          if (bookingStatus === "fully-booked") {
            throw new Error("Requested slot is no longer available");
          }

          // Update webinar status
          const updatedWebinar = await tx.webinar.update({
            where: { id: webinarId },
            data: {
              status: "SCHEDULED",
            },
            include: webinarInclude,
          });

          return {
            webinar: updatedWebinar,
            appointment: webinar.appointment,
          };
        }

        // For auto/manual allocation, delete existing appointment if any
        if (!body.useRequestedSlots && webinar.appointment) {
          await tx.appointment.delete({
            where: { id: webinar.appointment.id },
          });
        }

        // Get slot(s) based on allocation method
        let selectedSlot: Date | undefined;
        let selectedSlots: Date[] | undefined;
        if (body.useRequestedSlots) {
          selectedSlot = await allocateSlotRequested(webinar, tx);
        } else if (body.isAuto) {
          selectedSlot = await allocateSlotAuto(webinar, tx);
        } else {
          selectedSlots = await allocateSlotManual(webinar, body.slots!, tx);
        }

        const requiredSlots = Math.ceil(
          webinar.webinarPlan.durationInHours / 0.5,
        );
        const hostUserId = (() => {
          if (!webinar.webinarPlan.consultantProfile?.user?.id) {
            throw new Error("Missing consultant user information");
          }
          return webinar.webinarPlan.consultantProfile.user.id;
        })();

        const appointment = await tx.appointment.create({
          data: {
            appointmentType: AppointmentsType.WEBINAR,
            webinar: { connect: { id: webinarId } },
            slotsOfAppointment: {
              create: (selectedSlots && selectedSlots.length === requiredSlots
                ? selectedSlots
                : Array.from({ length: requiredSlots }).map((_, i) =>
                    addMinutes(selectedSlot as Date, i * 30),
                  )
              ).map((start) => ({
                slotStartTimeInUTC: start,
                slotEndTimeInUTC: addMinutes(start, 30),
                isTentative: false,
                user: { connect: [{ id: hostUserId }] },
              })),
            },
          },
          include: {
            slotsOfAppointment: { include: { user: true } },
          },
        });

        // Update webinar status
        const updatedWebinar = await tx.webinar.update({
          where: { id: webinarId },
          data: {
            status: "SCHEDULED",
          },
          include: webinarInclude,
        });

        return {
          webinar: updatedWebinar,
          appointment,
        };
      });

      return NextResponse.json({ data: result });
    } catch (error) {
      if (error instanceof Error) {
        console.error("Error: ", error.stack);
      }
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to allocate slot",
        },
        { status: 500 },
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error("Error: ", error.stack);
    }
    return NextResponse.json(
      { error: "An error occurred during slot allocation" },
      { status: 500 },
    );
  }
}
