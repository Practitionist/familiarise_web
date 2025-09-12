import prisma from "@/lib/prisma";
import {
  AppointmentsType,
  DayOfWeek,
  Prisma,
  RequestStatus,
  ScheduleType,
  SlotOfAvailabilityCustom,
  SlotOfAvailabilityWeekly,
} from "@prisma/client";
import { addHours, addMonths } from "date-fns";
import { countSundayWeeksInclusive } from "@/app/dashboard/consultant/[consultantId]/(features)/shared/utils/calendarUtils";
import { NextRequest, NextResponse } from "next/server";

type PrismaTransaction = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use"
>;

interface AllocationRequest {
  isAuto: boolean;
  slots?: string[]; // Required for manual allocation
  useRequestedSlots?: boolean; // For using consultee's requested slots
}

const subscriptionInclude = {
  startDate: true,
  endDate: true,
  subscriptionPlan: {
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
} as const;

type SubscriptionWithRelations = Prisma.SubscriptionGetPayload<{
  include: typeof subscriptionInclude;
}>;

async function allocateSlotsAuto(
  subscription: SubscriptionWithRelations,
  tx: PrismaTransaction,
): Promise<Date[]> {
  const { subscriptionPlan, requestedBy } = subscription;
  const { consultantProfile } = subscriptionPlan;

  if (!consultantProfile) {
    throw new Error("Consultant profile not found");
  }

  // Calculate required slots per call
  const slotsPerCall = Math.ceil(subscriptionPlan.sessionDurationInHours / 0.5);
  const callsPerWeek = subscriptionPlan.callsPerWeek;

  // Get available slots based on schedule type
  const availableSlots =
    consultantProfile.scheduleType === ScheduleType.WEEKLY
      ? consultantProfile.slotsOfAvailabilityWeekly
      : consultantProfile.slotsOfAvailabilityCustom;

  if (!availableSlots.length) {
    throw new Error(
      "No available slots found for consultant. Please set up your availability schedule first.",
    );
  }

  // Get all existing appointments to check for conflicts
  const existingAppointments = await tx.appointment.findMany({
    where: {
      AND: [
        {
          OR: [
            { subscription: { requestStatus: RequestStatus.APPROVED } },
            { consultation: { requestStatus: RequestStatus.APPROVED } },
          ],
        },
        {
          slotsOfAppointment: {
            some: {
              user: {
                some: {
                  id: { in: [consultantProfile.user.id, requestedBy.user.id] },
                },
              },
            },
          },
        },
      ],
    },
    include: {
      slotsOfAppointment: { include: { user: true } },
    },
  });

  // Get booked time slots
  const bookedSlots = new Set(
    existingAppointments.flatMap((app) =>
      (app.slotsOfAppointment || []).map((slot: { slotStartTimeInUTC: Date }) =>
        slot.slotStartTimeInUTC.toISOString(),
      ),
    ),
  );

  // Sort slots by time of day to prioritize earlier slots (FCFS within a day)
  const sortedSlots = [...availableSlots].sort((a, b) => {
    const timeA =
      new Date(a.slotStartTimeInUTC).getHours() * 60 +
      new Date(a.slotStartTimeInUTC).getMinutes();
    const timeB =
      new Date(b.slotStartTimeInUTC).getHours() * 60 +
      new Date(b.slotStartTimeInUTC).getMinutes();
    return timeA - timeB;
  });

  const now = new Date();

  // Map JS Date.getUTCDay() to Prisma DayOfWeek enum (use UTC to align with DB fields)
  const getUtcDayOfWeek = (date: Date): DayOfWeek => {
    const days = [
      DayOfWeek.SUNDAY,
      DayOfWeek.MONDAY,
      DayOfWeek.TUESDAY,
      DayOfWeek.WEDNESDAY,
      DayOfWeek.THURSDAY,
      DayOfWeek.FRIDAY,
      DayOfWeek.SATURDAY,
    ];
    return days[date.getUTCDay()];
  };

  const getUtcDayKey = (date: Date): string => {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const dnum = date.getUTCDate();
    const dt = new Date(Date.UTC(y, m, dnum, 0, 0, 0, 0));
    return dt.toISOString().split("T")[0];
  };

  // Helper: start of week (Sunday) and end of week (Saturday) for the current week
  const startOfWeekSundayUtc = (d: Date): Date => {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const dayOfMonth = d.getUTCDate();
    const dow = d.getUTCDay();
    const sunday = new Date(Date.UTC(y, m, dayOfMonth - dow, 0, 0, 0, 0));
    return sunday;
  };

  const endOfWeekSaturdayUtc = (d: Date): Date => {
    const start = startOfWeekSundayUtc(d);
    const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
    end.setUTCHours(23, 59, 59, 999);
    return end;
  };

  // Use subscription date range instead of current week
  const subscriptionStartDate = new Date(subscription.startDate);
  const subscriptionEndDate = new Date(subscription.endDate);

  // Start from the later of: now or subscription start date
  const effectiveStartDate =
    now > subscriptionStartDate ? now : subscriptionStartDate;

  // Build fast lookup structures of availability per schedule type
  // WEEKLY: list of time ranges (minutes-of-day) per DayOfWeek
  const weeklyRangesByDow: Map<
    DayOfWeek,
    Array<{ start: number; end: number }>
  > = new Map();
  if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
    for (const ws of consultantProfile.slotsOfAvailabilityWeekly) {
      const dow: DayOfWeek = ws.dayOfWeekforStartTimeInUTC;
      const startMinutes =
        new Date(ws.slotStartTimeInUTC).getUTCHours() * 60 +
        new Date(ws.slotStartTimeInUTC).getUTCMinutes();
      const endMinutes =
        new Date(ws.slotEndTimeInUTC).getUTCHours() * 60 +
        new Date(ws.slotEndTimeInUTC).getUTCMinutes();
      if (!weeklyRangesByDow.has(dow)) weeklyRangesByDow.set(dow, []);
      weeklyRangesByDow
        .get(dow)!
        .push({ start: startMinutes, end: endMinutes });
    }
    // Normalize and sort ranges
    for (const dow of Array.from(weeklyRangesByDow.keys())) {
      const ranges = weeklyRangesByDow.get(dow)!;
      ranges.sort((a, b) => a.start - b.start);
    }
  }

  // CUSTOM: list of ranges per date (UTC day)
  const customRangesByDay: Map<
    string,
    Array<{ start: Date; end: Date }>
  > = new Map();
  if (consultantProfile.scheduleType === ScheduleType.CUSTOM) {
    for (const cs of consultantProfile.slotsOfAvailabilityCustom) {
      const start = new Date(cs.slotStartTimeInUTC);
      const end = new Date(cs.slotEndTimeInUTC);
      const key = getUtcDayKey(start);
      if (!customRangesByDay.has(key)) customRangesByDay.set(key, []);
      customRangesByDay.get(key)!.push({ start, end });
    }
    for (const key of Array.from(customRangesByDay.keys())) {
      const ranges = customRangesByDay.get(key)!;
      ranges.sort((a, b) => a.start.getTime() - b.start.getTime());
    }
  }

  const selectedCallStartTimes: Date[] = [];
  let totalCallsAllocated = 0;
  const maxTotalCalls =
    countSundayWeeksInclusive(subscriptionStartDate, subscriptionEndDate) *
    callsPerWeek;

  // Iterate through all weeks in the subscription period
  let currentWeekStart = startOfWeekSundayUtc(effectiveStartDate);

  while (
    totalCallsAllocated < maxTotalCalls &&
    currentWeekStart <= subscriptionEndDate
  ) {
    const weekEnd = endOfWeekSaturdayUtc(currentWeekStart);
    let callsThisWeek = 0;

    // Iterate days in this week
    for (
      let day = new Date(currentWeekStart);
      day <= weekEnd &&
      callsThisWeek < callsPerWeek &&
      totalCallsAllocated < maxTotalCalls;
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
    ) {
      // Skip if this day is outside subscription period
      if (day < subscriptionStartDate || day > subscriptionEndDate) {
        continue;
      }

      // Skip if this day is in the past (but allow today)
      if (day < now && getUtcDayKey(day) !== getUtcDayKey(now)) {
        continue;
      }

      for (const slot of sortedSlots) {
        let firstSlotTime: Date;

        if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
          // Only consider this slot if its configured weekday matches the current day (UTC-aware)
          const weeklySlot = slot as SlotOfAvailabilityWeekly;
          if (weeklySlot.dayOfWeekforStartTimeInUTC !== getUtcDayOfWeek(day))
            continue;

          // Construct candidate using UTC date + UTC hours/minutes from weekly availability
          const slotStartUtc = new Date(weeklySlot.slotStartTimeInUTC);
          firstSlotTime = new Date(
            Date.UTC(
              day.getUTCFullYear(),
              day.getUTCMonth(),
              day.getUTCDate(),
              slotStartUtc.getUTCHours(),
              slotStartUtc.getUTCMinutes(),
              0,
              0,
            ),
          );
        } else {
          // CUSTOM: use exact slot date but only within the current week window (UTC day match)
          const customSlot = slot as SlotOfAvailabilityCustom;
          const candidate = new Date(customSlot.slotStartTimeInUTC);
          if (getUtcDayKey(candidate) !== getUtcDayKey(day)) continue;
          firstSlotTime = candidate;
        }

        // Enforce subscription date range and no past slots
        if (firstSlotTime <= now) continue;
        if (
          firstSlotTime < subscriptionStartDate ||
          firstSlotTime > subscriptionEndDate
        )
          continue;
        if (bookedSlots.has(firstSlotTime.toISOString())) continue;

        // Try to allocate a complete call (consecutive slots) for this day
        const consecutiveSlots: Date[] = [];
        let currentSlotTime = new Date(firstSlotTime);
        let canAllocateCall = true;

        for (let i = 0; i < slotsPerCall; i++) {
          const slotTime = new Date(currentSlotTime);

          // must stay within the same day
          if (getUtcDayKey(slotTime) !== getUtcDayKey(firstSlotTime)) {
            canAllocateCall = false;
            break;
          }

          // must not be booked
          if (bookedSlots.has(slotTime.toISOString())) {
            canAllocateCall = false;
            break;
          }

          // must be part of consultant's declared availability
          if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
            const dow = getUtcDayOfWeek(firstSlotTime);
            const minutes =
              slotTime.getUTCHours() * 60 + slotTime.getUTCMinutes();
            const ranges = weeklyRangesByDow.get(dow) || [];
            // Check that this slot and its 30-min window stay within at least one range
            const withinRange = ranges.some(
              (r) => minutes >= r.start && minutes + 30 <= r.end,
            );
            if (!withinRange) {
              canAllocateCall = false;
              break;
            }
          } else {
            const dayKey = getUtcDayKey(slotTime);
            const ranges = customRangesByDay.get(dayKey) || [];
            const slotEnd = new Date(slotTime.getTime() + 30 * 60 * 1000);
            const withinRange = ranges.some(
              (r) =>
                slotTime.getTime() >= r.start.getTime() &&
                slotEnd.getTime() <= r.end.getTime(),
            );
            if (!withinRange) {
              canAllocateCall = false;
              break;
            }
          }

          consecutiveSlots.push(slotTime);
          currentSlotTime = new Date(slotTime.getTime() + 30 * 60 * 1000);
        }

        if (canAllocateCall && consecutiveSlots.length === slotsPerCall) {
          // Found a valid call slot for this day
          selectedCallStartTimes.push(firstSlotTime);

          // Mark all slots for this call as booked for future iterations
          consecutiveSlots.forEach((slot) =>
            bookedSlots.add(slot.toISOString()),
          );

          callsThisWeek++;
          totalCallsAllocated++;
          break; // Move to next day after finding first available slot
        }
      }
    }

    // Move to next week
    currentWeekStart = new Date(
      currentWeekStart.getTime() + 7 * 24 * 60 * 60 * 1000,
    );
  }

  if (selectedCallStartTimes.length === 0) {
    throw new Error(
      `Unable to allocate any calls within the subscription period (${subscriptionStartDate.toLocaleDateString()} to ${subscriptionEndDate.toLocaleDateString()}). This subscription allows scheduling only between ${subscriptionStartDate.toLocaleString()} and ${subscriptionEndDate.toLocaleString()}. Please check for conflicts or add more availability.`,
    );
  }

  // Sort selected call start times
  const sorted = [...selectedCallStartTimes].sort(
    (a, b) => a.getTime() - b.getTime(),
  );

  return sorted;
}

async function allocateSlotsRequested(
  subscription: SubscriptionWithRelations,
  tx: PrismaTransaction,
): Promise<Date[]> {
  // Get the requested slots from appointments
  const requestedSlots = subscription.appointments?.flatMap(
    (appt) =>
      appt.slotsOfAppointment?.map(
        (slot) => new Date(slot.slotStartTimeInUTC),
      ) || [],
  );

  if (!requestedSlots?.length) {
    throw new Error("No requested slots found");
  }

  // Validate all slots are still available
  const existingAppointments = await tx.appointment.findMany({
    where: {
      AND: [
        {
          OR: [
            { subscription: { requestStatus: RequestStatus.APPROVED } },
            { consultation: { requestStatus: RequestStatus.APPROVED } },
          ],
        },
        {
          slotsOfAppointment: {
            some: {
              slotStartTimeInUTC: {
                in: requestedSlots,
              },
            },
          },
        },
      ],
    },
  });

  if (existingAppointments.length > 0) {
    throw new Error("Some requested slots are no longer available");
  }

  return requestedSlots;
}

// Helper functions (kept for manual allocation)
function getDayOfWeek(date: Date): DayOfWeek {
  const days = [
    DayOfWeek.SUNDAY,
    DayOfWeek.MONDAY,
    DayOfWeek.TUESDAY,
    DayOfWeek.WEDNESDAY,
    DayOfWeek.THURSDAY,
    DayOfWeek.FRIDAY,
    DayOfWeek.SATURDAY,
  ];
  return days[date.getDay()];
}

function isSameDay(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

async function allocateSlotsManual(
  subscription: SubscriptionWithRelations,
  slots: string[],
  tx: PrismaTransaction,
): Promise<Date[]> {
  const { subscriptionPlan } = subscription;
  const { consultantProfile } = subscriptionPlan;

  if (!consultantProfile) {
    throw new Error("Consultant profile not found");
  }

  const _consultantTimezone = consultantProfile.user.currentTimezone || "UTC";

  // Convert string dates to Date objects for validation
  const slotDates = slots.map((slot) => new Date(slot));

  // Validate all slots are in the future
  const now = new Date();
  for (const slotDate of slotDates) {
    if (slotDate <= now) {
      throw new Error("Cannot allocate slots in the past");
    }
  }

  // Validate slots match consultant's schedule type
  if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
    // For weekly schedule, validate slots follow the weekly pattern
    const availableWeeklySlots = new Set(
      consultantProfile.slotsOfAvailabilityWeekly.map((slot) => {
        const dayNum = getDayOfWeek(new Date(slot.slotStartTimeInUTC));
        const hours = new Date(slot.slotStartTimeInUTC).getHours();
        const minutes = new Date(slot.slotStartTimeInUTC).getMinutes();
        return `${dayNum}-${hours}-${minutes}`;
      }),
    );

    for (const slotDate of slotDates) {
      const slotPattern = `${getDayOfWeek(slotDate)}-${slotDate.getHours()}-${slotDate.getMinutes()}`;
      if (!availableWeeklySlots.has(slotPattern)) {
        throw new Error(
          `Slot ${slotDate.toLocaleString()} does not match consultant's weekly schedule`,
        );
      }
    }
  } else {
    // For custom schedule, validate slots exist in custom slots
    const availableCustomSlots = new Set(
      consultantProfile.slotsOfAvailabilityCustom.map((slot) =>
        new Date(slot.slotStartTimeInUTC).toISOString(),
      ),
    );

    for (const slotDate of slotDates) {
      if (!availableCustomSlots.has(slotDate.toISOString())) {
        throw new Error(
          `Slot ${slotDate.toLocaleString()} is not in consultant's custom schedule`,
        );
      }
    }
  }

  // Check for conflicts with existing appointments
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
          ],
        },
        {
          slotsOfAppointment: {
            some: {
              slotStartTimeInUTC: {
                in: slotDates,
              },
            },
          },
        },
      ],
    },
    include: {
      slotsOfAppointment: {
        include: {
          user: true,
        },
      },
    },
  });

  if (existingAppointments.length > 0) {
    throw new Error("Some selected slots are already booked");
  }

  // Boundary guard: all selected slots must be within existing subscription window
  const sortedSlotDates = [...slotDates].sort(
    (a, b) => a.getTime() - b.getTime(),
  );
  for (const d of sortedSlotDates) {
    if (d < subscription.startDate || d > subscription.endDate) {
      throw new Error(
        `Slot ${d.toISOString()} is outside subscription period (${subscription.startDate.toISOString()} - ${subscription.endDate.toISOString()})`,
      );
    }
  }

  // Enhanced subscription validation using the new service
  const { SubscriptionValidationService } = await import(
    "@/utils/subscriptionValidation"
  );
  const validationService = new SubscriptionValidationService(
    tx as unknown as Prisma.TransactionClient,
  );

  const validationResult = await validationService.validateSubscriptionSlots(
    subscription.id,
    slots,
  );

  if (!validationResult.isValid) {
    const errorMessage = validationResult.errors.join("; ");
    throw new Error(`Subscription validation failed: ${errorMessage}`);
  }

  // Handle warnings if any
  if (validationResult.warnings.length > 0) {
    // Warnings are handled in validation result
  }

  // Convert selected 30-min slots into call start times (one per complete call/day)
  const slotsPerCall = Math.ceil(subscriptionPlan.sessionDurationInHours / 0.5);
  const slotsByDay = new Map<string, Date[]>();
  for (const d of sortedSlotDates) {
    const key = d.toDateString();
    if (!slotsByDay.has(key)) slotsByDay.set(key, []);
    slotsByDay.get(key)!.push(d);
  }

  const callStartTimes: Date[] = [];
  for (const key of Array.from(slotsByDay.keys())) {
    const daySlots = slotsByDay.get(key)!;
    const sorted = [...daySlots].sort((a, b) => a.getTime() - b.getTime());
    if (sorted.length < slotsPerCall) {
      throw new Error(
        "Incomplete call selected: not enough consecutive slots in a day",
      );
    }
    for (let i = 1; i < slotsPerCall; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (curr.getTime() !== prev.getTime() + 30 * 60 * 1000) {
        throw new Error("Selected slots must be consecutive within a day");
      }
    }
    callStartTimes.push(sorted[0]);
  }

  return callStartTimes.sort((a, b) => a.getTime() - b.getTime());
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const { subscriptionId } = await params;
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

    // Fetch subscription with necessary relations
    const subscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: subscriptionInclude,
    });

    if (!subscription) {
      return NextResponse.json(
        { error: "Subscription not found" },
        { status: 404 },
      );
    }

    // Validate user information
    if (
      !subscription.subscriptionPlan?.consultantProfile?.user?.id ||
      !subscription.requestedBy?.user?.id
    ) {
      return NextResponse.json(
        { error: "Missing user information" },
        { status: 400 },
      );
    }

    const { consultantProfile } = subscription.subscriptionPlan;
    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 400 },
      );
    }

    // Check if subscription is already approved
    if (subscription.requestStatus === RequestStatus.APPROVED) {
      return NextResponse.json(
        { error: "Subscription is already approved" },
        { status: 400 },
      );
    }

    try {
      // Use transaction to ensure atomic updates
      const result = await prisma.$transaction(
        async (tx) => {
          // If using requested slots and appointments exist, just approve the subscription
          if (body.useRequestedSlots && subscription.appointments?.length > 0) {
            // Validate all slots are still available
            const requestedSlots = subscription.appointments.flatMap((appt) =>
              appt.slotsOfAppointment.map((slot) => slot.slotStartTimeInUTC),
            );

            const existingAppointments = await tx.appointment.findMany({
              where: {
                AND: [
                  {
                    OR: [
                      {
                        subscription: { requestStatus: RequestStatus.APPROVED },
                      },
                      {
                        consultation: { requestStatus: RequestStatus.APPROVED },
                      },
                    ],
                  },
                  {
                    slotsOfAppointment: {
                      some: {
                        slotStartTimeInUTC: {
                          in: requestedSlots,
                        },
                      },
                    },
                  },
                ],
              },
            });

            if (existingAppointments.length > 0) {
              throw new Error("Some requested slots are no longer available");
            }

            // Validate requested slots fall within allowed subscription period if defined
            if (subscription.startDate && subscription.endDate) {
              const allowedStart = new Date(subscription.startDate);
              const allowedEnd = new Date(subscription.endDate);
              for (const d of requestedSlots) {
                const dt = new Date(d);
                if (dt < allowedStart || dt > allowedEnd) {
                  throw new Error(
                    `Selected slot ${dt.toLocaleString()} is outside subscription period (${allowedStart.toLocaleString()} - ${allowedEnd.toLocaleString()})`,
                  );
                }
              }
            }

            // Just approve the subscription
            const updatedSubscription = await tx.subscription.update({
              where: { id: subscriptionId },
              data: {
                requestStatus: RequestStatus.APPROVED,
                startDate: requestedSlots[0],
                endDate: addMonths(
                  requestedSlots[0],
                  subscription.subscriptionPlan.durationInMonths,
                ),
              },
              include: subscriptionInclude,
            });

            return {
              subscription: updatedSubscription,
              appointments: subscription.appointments,
            };
          }

          // For auto/manual allocation, delete existing appointments if any
          if (
            !body.useRequestedSlots &&
            subscription.appointments?.length > 0
          ) {
            await Promise.all(
              subscription.appointments.map((appointment) =>
                tx.appointment.delete({
                  where: { id: appointment.id },
                }),
              ),
            );
          }

          // Get slots based on allocation method
          let selectedSlots;
          if (body.useRequestedSlots) {
            selectedSlots = await allocateSlotsRequested(subscription, tx);
          } else if (body.isAuto) {
            selectedSlots = await allocateSlotsAuto(subscription, tx);
          } else {
            selectedSlots = await allocateSlotsManual(
              subscription,
              body.slots!,
              tx,
            );
          }

          // Boundary guard: ensure all auto/requested selections lie within the subscription window
          if (subscription.startDate && subscription.endDate) {
            const allowedStart = new Date(subscription.startDate);
            const allowedEnd = new Date(subscription.endDate);
            for (const d of selectedSlots as Date[]) {
              if (d < allowedStart || d > allowedEnd) {
                throw new Error(
                  `Selected slot ${d.toLocaleString()} is outside subscription period (${allowedStart.toLocaleString()} - ${allowedEnd.toLocaleString()})`,
                );
              }
            }
          }

          // Create appointments for selected slots
          const appointments = await Promise.all(
            selectedSlots.map((slotTime: Date) =>
              tx.appointment.create({
                data: {
                  appointmentType: AppointmentsType.SUBSCRIPTION,
                  subscription: {
                    connect: { id: subscriptionId },
                  },
                  slotsOfAppointment: {
                    create: {
                      slotStartTimeInUTC: slotTime,
                      slotEndTimeInUTC: addHours(
                        slotTime,
                        subscription.subscriptionPlan.sessionDurationInHours,
                      ),
                      isTentative: false,
                      user: {
                        connect: [
                          { id: subscription.requestedBy.user.id },
                          {
                            id: subscription.subscriptionPlan.consultantProfile
                              .user.id,
                          },
                        ],
                      },
                    },
                  },
                },
                include: {
                  slotsOfAppointment: {
                    include: {
                      user: true,
                    },
                  },
                },
              }),
            ),
          );

          // Update subscription status
          const updatedSubscription = await tx.subscription.update({
            where: { id: subscriptionId },
            data: {
              requestStatus: RequestStatus.APPROVED,
              startDate: selectedSlots[0],
              endDate: addMonths(
                selectedSlots[0],
                subscription.subscriptionPlan.durationInMonths,
              ),
            },
            include: subscriptionInclude,
          });

          return {
            subscription: updatedSubscription,
            appointments,
          };
        },
        {
          timeout: 30000, // Increase timeout to 30 seconds for subscription allocations
        },
      );

      return NextResponse.json({ data: result });
    } catch (error) {
      if (error instanceof Error) {
        // Handle error silently or use proper error reporting
      }
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to allocate slots",
        },
        { status: 500 },
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      // Handle error silently or use proper error reporting
    }
    return NextResponse.json(
      { error: "An error occurred during slot allocation" },
      { status: 500 },
    );
  }
}
