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
import { addHours, addWeeks } from "date-fns";
import { NextRequest, NextResponse } from "next/server";
import { notifyRequestUpdate } from "@/utils/realTimeNotifications";

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
  const { subscriptionPlan, requestedBy } = subscription;
  const { consultantProfile } = subscriptionPlan;

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
                    in: [consultantProfile.user.id, requestedBy.user.id],
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

  // Calculate required number of slots - use more precise week calculation
  const totalDays = subscriptionPlan.durationInMonths * 30; // Approximate days
  const totalWeeks = Math.ceil(totalDays / 7); // Round up to ensure we cover the full period
  const totalRequiredSlots = totalWeeks * subscriptionPlan.callsPerWeek;

  // Find best available slots
  const selectedSlots: Date[] = [];
  const startDate = new Date();
  startDate.setHours(0, 0, 0, 0); // Start from beginning of today
  let currentWeek = 0;

  while (
    selectedSlots.length < totalRequiredSlots &&
    currentWeek < totalWeeks
  ) {
    const weekStart = addWeeks(startDate, currentWeek);
    let slotsThisWeek = 0;

    // For weekly schedule, try to find slots for each day of the week
    if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
      // Group weekly slots by day of week
      const slotsByDay = new Map<DayOfWeek, SlotOfAvailabilityWeekly[]>();
      sortedSlots.forEach((slot) => {
        const weeklySlot = slot as SlotOfAvailabilityWeekly;
        const daySlots = slotsByDay.get(weeklySlot.dayOfWeekforStartTimeInUTC) || [];
        daySlots.push(weeklySlot);
        slotsByDay.set(weeklySlot.dayOfWeekforStartTimeInUTC, daySlots);
      });

      // Try to distribute slots evenly across the week
      const daysWithSlots = Array.from(slotsByDay.keys());
      let dayIndex = 0;

      while (slotsThisWeek < subscriptionPlan.callsPerWeek && dayIndex < daysWithSlots.length * 3) {
        const dayOfWeek = daysWithSlots[dayIndex % daysWithSlots.length];
        const daySlots = slotsByDay.get(dayOfWeek) || [];
        
        // Calculate the actual date for this day of week in the current week
        const targetDate = new Date(weekStart);
        const currentDayOfWeek = targetDate.getDay();
        const targetDayNum = Object.values(DayOfWeek).indexOf(dayOfWeek);
        const daysToAdd = (targetDayNum - currentDayOfWeek + 7) % 7;
        targetDate.setDate(targetDate.getDate() + daysToAdd);

        // Try to find an available slot for this day
        for (const weeklySlot of daySlots) {
          const slotTime = new Date(targetDate);
          slotTime.setHours(
            weeklySlot.slotStartTimeInUTC.getHours(),
            weeklySlot.slotStartTimeInUTC.getMinutes(),
            0,
            0,
          );

          // Skip if slot is already booked, in the past, or we already have enough slots this week
          if (
            bookedSlots.has(slotTime.toISOString()) || 
            slotTime < new Date() ||
            slotsThisWeek >= subscriptionPlan.callsPerWeek
          ) {
            continue;
          }

          // Found a valid slot
          selectedSlots.push(slotTime);
          bookedSlots.add(slotTime.toISOString());
          slotsThisWeek++;
          break; // Move to next day after finding a slot
        }
        
        dayIndex++;
      }
    } else {
      // For custom schedule, process each day of the week
      for (
        let dayOffset = 0;
        dayOffset < 7 && slotsThisWeek < subscriptionPlan.callsPerWeek;
        dayOffset++
      ) {
        const currentDay = new Date(weekStart);
        currentDay.setDate(currentDay.getDate() + dayOffset);

        // Try to find the first available slot for this day
        for (const slot of sortedSlots) {
          const customSlot = slot as SlotOfAvailabilityCustom;
          
          // For custom slots, check if the slot is for this specific day
          if (!isSameDay(customSlot.slotStartTimeInUTC, currentDay)) {
            continue;
          }

          const slotTime = new Date(customSlot.slotStartTimeInUTC);

          // Skip if slot is already booked or in the past
          if (bookedSlots.has(slotTime.toISOString()) || slotTime < new Date()) {
            continue;
          }

          // Found a valid slot for this day
          selectedSlots.push(slotTime);
          bookedSlots.add(slotTime.toISOString());
          slotsThisWeek++;
          break; // Move to next day after finding first available slot
        }
      }
    }

    // If we couldn't find enough slots for this week, that's okay for later weeks
    // but we should have at least some slots
    if (currentWeek === 0 && slotsThisWeek === 0) {
      throw new Error("Could not find any available slots for the first week");
    }

    currentWeek++;
  }

  if (selectedSlots.length === 0) {
    throw new Error("No available slots found for the subscription period");
  }

  // If we couldn't find all required slots, that's okay - return what we found
  // The consultant can manually adjust if needed
  return selectedSlots.sort((a, b) => a.getTime() - b.getTime());
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
  const { subscriptionPlan, requestedBy } = subscription;
  const { consultantProfile } = subscriptionPlan;

  // Calculate expected number of slots (but allow flexibility)
  const totalDays = subscriptionPlan.durationInMonths * 30;
  const totalWeeks = Math.ceil(totalDays / 7);
  const expectedSlots = totalWeeks * subscriptionPlan.callsPerWeek;

  // Validate minimum slots (at least 1 slot per week for first month)
  const minimumSlots = Math.min(4 * subscriptionPlan.callsPerWeek, expectedSlots);
  
  if (slots.length < minimumSlots) {
    throw new Error(
      `At least ${minimumSlots} slots required (minimum 1 month coverage), but received ${slots.length}`,
    );
  }

  // Allow up to 20% more slots than expected for flexibility
  const maximumSlots = Math.ceil(expectedSlots * 1.2);
  if (slots.length > maximumSlots) {
    throw new Error(
      `Too many slots provided. Maximum ${maximumSlots} slots allowed, but received ${slots.length}`,
    );
  }

  // Convert string dates to Date objects for validation
  const slotDates = slots.map((slot, index) => {
    const date = new Date(slot);
    if (isNaN(date.getTime())) {
      throw new Error(`Invalid date format for slot ${index + 1}: ${slot}`);
    }
    return date;
  });

  // Validate all slots are in the future
  const now = new Date();
  const pastSlots = slotDates.filter(date => date <= now);
  if (pastSlots.length > 0) {
    throw new Error(`Cannot allocate ${pastSlots.length} slots in the past`);
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

    const invalidSlots = slotDates.filter(slotDate => {
      const slotPattern = `${getDayOfWeek(slotDate)}-${slotDate.getHours()}-${slotDate.getMinutes()}`;
      return !availableWeeklySlots.has(slotPattern);
    });

    if (invalidSlots.length > 0) {
      throw new Error(
        `${invalidSlots.length} slots do not match consultant's weekly schedule. First invalid slot: ${invalidSlots[0].toLocaleString()}`,
      );
    }
  } else {
    // For custom schedule, validate slots exist in custom slots
    const availableCustomSlots = new Set(
      consultantProfile.slotsOfAvailabilityCustom.map((slot) =>
        new Date(slot.slotStartTimeInUTC).toISOString(),
      ),
    );

    const invalidSlots = slotDates.filter(slotDate => 
      !availableCustomSlots.has(slotDate.toISOString())
    );

    if (invalidSlots.length > 0) {
      throw new Error(
        `${invalidSlots.length} slots are not in consultant's custom schedule. First invalid slot: ${invalidSlots[0].toLocaleString()}`,
      );
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
      slotsOfAppointment: true,
    },
  });

  if (existingAppointments.length > 0) {
    const conflictingSlots = existingAppointments.flatMap(app => 
      app.slotsOfAppointment.map(slot => slot.slotStartTimeInUTC.toISOString())
    );
    throw new Error(
      `${conflictingSlots.length} selected slots are already booked. First conflict: ${new Date(conflictingSlots[0]).toLocaleString()}`
    );
  }

  // Validate slots per week quota (with some flexibility)
  const slotsByWeek = new Map<string, number>();
  for (const slotDate of slotDates) {
    const weekStart = new Date(slotDate);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Get start of week
    weekStart.setHours(0, 0, 0, 0); // Normalize to start of day
    const weekKey = weekStart.toISOString();
    slotsByWeek.set(weekKey, (slotsByWeek.get(weekKey) || 0) + 1);
  }

  // Allow up to 2x the weekly quota for flexibility (consultant might want to front-load)
  const maxSlotsPerWeek = subscriptionPlan.callsPerWeek * 2;
  const overloadedWeeks = Array.from(slotsByWeek.entries()).filter(
    ([week, count]) => count > maxSlotsPerWeek
  );

  if (overloadedWeeks.length > 0) {
    const [week, count] = overloadedWeeks[0];
    throw new Error(
      `Too many slots allocated for week of ${new Date(week).toLocaleDateString()}: ${count} slots (max ${maxSlotsPerWeek} recommended)`,
    );
  }

  // Return sorted slots
  return slotDates.sort((a, b) => a.getTime() - b.getTime());
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
                endDate: addWeeks(
                  requestedSlots[0],
                  subscription.subscriptionPlan.durationInMonths * 4,
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
                      slotEndTimeInUTC: addHours(slotTime, 1),
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
              endDate: addWeeks(
                selectedSlots[0],
                subscription.subscriptionPlan.durationInMonths * 4,
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

      // Trigger real-time notification
      notifyRequestUpdate(
        result.subscription.subscriptionPlan.consultantProfile.user.id,
        subscriptionId,
        {
          action: body.isAuto ? 'auto_allocation' : body.useRequestedSlots ? 'requested_allocation' : 'manual_allocation',
          appointmentIds: result.appointments.map(app => app.id),
          subscriptionType: true,
        }
      );

      return NextResponse.json({ data: result });
    } catch (error) {
      if (error instanceof Error) {
        // Fixes the below error:
        //  ⨯ TypeError: The "payload" argument must be of type object. Received null
        console.error("Error: ", error.stack);
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
      // Fixes the below error:
      //  ⨯ TypeError: The "payload" argument must be of type object. Received null
      console.error("Error: ", error.stack);
    }
    return NextResponse.json(
      { error: "An error occurred during slot allocation" },
      { status: 500 },
    );
  }
}
