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
import { addHours, addWeeks, addMonths } from "date-fns";
// Note: countSundayWeeksInclusive not needed directly here; validation service handles week counting
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
  const { subscriptionPlan } = subscription;
  const { consultantProfile } = subscriptionPlan;

  if (!consultantProfile) {
    throw new Error("Consultant profile not found");
  }

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
          ],
        },
        {
          slotsOfAppointment: {
            some: {
              user: {
                some: {
                  id: {
                    in: [
                      consultantProfile.user.id,
                      subscription.requestedBy.user.id,
                    ],
                  },
                },
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

  // Get booked time slots
  const bookedSlots = new Set(
    existingAppointments.flatMap((app) =>
      app.slotsOfAppointment.map((slot: { slotStartTimeInUTC: Date }) =>
        slot.slotStartTimeInUTC.toISOString(),
      ),
    ),
  );

  // Calculate required number of calls (not 30-min slots) for the plan
  // Using durationInMonths × callsPerWeek
  const totalRequiredCalls =
    subscriptionPlan.durationInMonths * subscriptionPlan.callsPerWeek;

  // Determine allocation window strictly from subscription
  const allocationStart = new Date(subscription.startDate);
  const allocationEnd = new Date(subscription.endDate);

  // Calculate a safe upper bound of weeks to iterate
  const totalWeeks = Math.max(
    1,
    Math.ceil(
      (allocationEnd.getTime() - allocationStart.getTime()) /
        (7 * 24 * 60 * 60 * 1000),
    ),
  );

  // Find best available slots
  const selectedSlots: Date[] = [];
  const startDate = allocationStart;
  let currentWeek = 0;

  while (
    selectedSlots.length < totalRequiredCalls &&
    currentWeek < totalWeeks
  ) {
    const weekStart = addWeeks(startDate, currentWeek);
    let slotsThisWeek = 0;

    // Process each day of the week
    for (
      let dayOffset = 0;
      dayOffset < 7 && slotsThisWeek < subscriptionPlan.callsPerWeek;
      dayOffset++
    ) {
      const currentDay = new Date(weekStart);
      currentDay.setDate(currentDay.getDate() + dayOffset);

      // Try to find the first available slot for this day
      for (const slot of sortedSlots) {
        const slotTime = new Date(currentDay);

        if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
          const weeklySlot = slot as SlotOfAvailabilityWeekly;
          // Skip if not the right day of week
          if (
            weeklySlot.dayOfWeekforStartTimeInUTC !== getDayOfWeek(currentDay)
          ) {
            continue;
          }
          slotTime.setHours(
            weeklySlot.slotStartTimeInUTC.getHours(),
            weeklySlot.slotStartTimeInUTC.getMinutes(),
            0,
            0,
          );
        } else {
          const customSlot = slot as SlotOfAvailabilityCustom;
          // For custom slots, check if the slot is for this specific day
          if (!isSameDay(customSlot.slotStartTimeInUTC, currentDay)) {
            continue;
          }
          slotTime.setTime(customSlot.slotStartTimeInUTC.getTime());
        }

        // Skip if slot is outside subscription window, already booked, or in the past
        if (
          slotTime < allocationStart ||
          slotTime > allocationEnd ||
          bookedSlots.has(slotTime.toISOString()) ||
          slotTime < new Date()
        ) {
          continue;
        }

        // Found a valid slot for this day
        selectedSlots.push(slotTime);
        bookedSlots.add(slotTime.toISOString());
        slotsThisWeek++;
        break; // Move to next day after finding first available slot
      }
    }

    if (slotsThisWeek < subscriptionPlan.callsPerWeek) {
      throw new Error(
        `Could not find enough available slots for week ${currentWeek + 1}`,
      );
    }

    currentWeek++;
  }

  if (selectedSlots.length < totalRequiredCalls) {
    throw new Error(
      `Required ${totalRequiredCalls} calls but could only find ${selectedSlots.length}`,
    );
  }

  // Before returning, validate against subscription rules and window
  const sorted = selectedSlots.sort((a, b) => a.getTime() - b.getTime());

  const { SubscriptionValidationService } = await import(
    "@/utils/subscriptionValidation"
  );
  const validationService = new SubscriptionValidationService(
    tx as unknown as Prisma.TransactionClient,
  );
  const validationResult = await validationService.validateSubscriptionSlots(
    subscription.id,
    sorted.map((d) => d.toISOString()),
  );

  if (!validationResult.isValid) {
    const errorMessage = validationResult.errors.join("; ");
    throw new Error(`Subscription validation failed: ${errorMessage}`);
  }

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

// Helper functions
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

  // Do not enforce raw slot count here; server-side validation will check calls per week/period

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
