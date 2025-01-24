import prisma from "@/lib/prisma";
import { AppointmentsType, DayOfWeek, Prisma, RequestStatus, ScheduleType, SlotOfAvailabilityCustom, SlotOfAvailabilityWeekly } from "@prisma/client";
import { addHours, addWeeks } from "date-fns";
import { NextRequest, NextResponse } from "next/server";

type PrismaTransaction = Omit<
  Prisma.TransactionClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use'
>;

interface AllocationRequest {
  isAuto: boolean;
  slots?: string[]; // Required for manual allocation
}

const subscriptionInclude = {
  subscriptionPlan: {
    include: {
      consultantProfile: {
        include: {
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
} as const;

type SubscriptionWithRelations = Prisma.SubscriptionGetPayload<{
  include: typeof subscriptionInclude;
}>;

async function allocateSlotsAuto(
  subscription: SubscriptionWithRelations,
  tx: PrismaTransaction
): Promise<Date[]> {
  const { subscriptionPlan, requestedBy } = subscription;
  const { consultantProfile } = subscriptionPlan;

  // Get available slots based on schedule type
  const availableSlots = consultantProfile.scheduleType === ScheduleType.WEEKLY
    ? consultantProfile.slotsOfAvailabilityWeekly
    : consultantProfile.slotsOfAvailabilityCustom;

  if (!availableSlots.length) {
    throw new Error("No available slots found for consultant");
  }

  // Get existing appointments to check for conflicts
  const existingAppointments = await tx.appointment.findMany({
    where: {
      slotsOfAppointment: {
        some: {
          user: {
            some: {
              id: {
                in: [
                  consultantProfile.user.id,
                  requestedBy.user.id
                ]
              }
            }
          }
        }
      }
    },
    include: {
      slotsOfAppointment: {
        include: {
          user: true
        }
      }
    }
  });

  // Get booked time slots
  const bookedSlots = new Set(
    existingAppointments.flatMap((app) =>
      app.slotsOfAppointment.map((slot) => slot.slotStartTimeInUTC.toISOString())
    )
  );

  // Calculate required number of slots
  const totalWeeks = subscriptionPlan.durationInMonths * 4;
  const totalRequiredSlots = totalWeeks * subscriptionPlan.callsPerWeek;

  // Find best available slots
  const selectedSlots: Date[] = [];
  const startDate = new Date();
  let currentWeek = 0;

  while (selectedSlots.length < totalRequiredSlots && currentWeek < totalWeeks) {
    const weekStart = addWeeks(startDate, currentWeek);
    
    // Try to find slots in consultant's preferred times
    for (const availableSlot of availableSlots) {
      const slotTime = new Date(weekStart);
      
      if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
        // For weekly slots, use the day and time
        const weeklySlot = availableSlot as SlotOfAvailabilityWeekly;
        slotTime.setHours(weeklySlot.slotStartTimeInUTC.getHours(), weeklySlot.slotStartTimeInUTC.getMinutes(), 0, 0);
        // Adjust day of week
        // Convert enum day to number (0-6)
        const dayToNumber = (day: DayOfWeek): number => {
          const days = {
            [DayOfWeek.SUNDAY]: 0,
            [DayOfWeek.MONDAY]: 1,
            [DayOfWeek.TUESDAY]: 2,
            [DayOfWeek.WEDNESDAY]: 3,
            [DayOfWeek.THURSDAY]: 4,
            [DayOfWeek.FRIDAY]: 5,
            [DayOfWeek.SATURDAY]: 6,
          };
          return days[day];
        };

        const currentDay = slotTime.getDay();
        const targetDay = dayToNumber(weeklySlot.dayOfWeekforStartTimeInUTC);
        const dayDiff = targetDay - currentDay;
        slotTime.setDate(slotTime.getDate() + dayDiff);
      } else {
        // For custom slots, use the exact date and time
        const customSlot = availableSlot as SlotOfAvailabilityCustom;
        slotTime.setTime(customSlot.slotStartTimeInUTC.getTime());
      }

      // Skip if slot is already booked or in the past
      if (
        bookedSlots.has(slotTime.toISOString()) ||
        slotTime < new Date()
      ) {
        continue;
      }

      // Add slot if we still need more for this week
      const slotsThisWeek = selectedSlots.filter(
        (slot) =>
          slot.getTime() >= weekStart.getTime() &&
          slot.getTime() < addWeeks(weekStart, 1).getTime()
      ).length;

      if (slotsThisWeek < subscriptionPlan.callsPerWeek) {
        selectedSlots.push(slotTime);
        bookedSlots.add(slotTime.toISOString());
      }

      if (selectedSlots.length === totalRequiredSlots) {
        break;
      }
    }
    currentWeek++;
  }

  if (selectedSlots.length < totalRequiredSlots) {
    throw new Error("Could not find enough available slots");
  }

  return selectedSlots;
}

async function allocateSlotsManual(
  subscription: SubscriptionWithRelations,
  slots: string[],
  tx: PrismaTransaction
): Promise<Date[]> {
  const { subscriptionPlan } = subscription;
  
  // Validate number of slots
  const totalWeeks = subscriptionPlan.durationInMonths * 4;
  const totalRequiredSlots = totalWeeks * subscriptionPlan.callsPerWeek;
  
  if (slots.length !== totalRequiredSlots) {
    throw new Error(`Expected ${totalRequiredSlots} slots but received ${slots.length}`);
  }

  // Check for conflicts
  const existingAppointments = await tx.appointment.findMany({
    where: {
      slotsOfAppointment: {
        some: {
          slotStartTimeInUTC: {
            in: slots.map(slot => new Date(slot)),
          },
        },
      },
    },
    include: {
      slotsOfAppointment: {
        include: {
          user: true
        }
      }
    }
  });

  if (existingAppointments.length > 0) {
    throw new Error("Some selected slots are already booked");
  }

  // Validate all slots are in the future
  const now = new Date();
  const invalidSlots = slots.filter(slot => new Date(slot) <= now);
  if (invalidSlots.length > 0) {
    throw new Error("Cannot allocate slots in the past");
  }

  // Convert string dates to Date objects and sort
  return slots.map(slot => new Date(slot)).sort((a, b) => a.getTime() - b.getTime());
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { subscriptionId: string } }
) {
  try {
    const { subscriptionId } = params;
    const body: AllocationRequest = await request.json();

    // Validate request body
    if (typeof body.isAuto !== 'boolean') {
      return NextResponse.json(
        { error: "isAuto flag is required" },
        { status: 400 }
      );
    }

    if (!body.isAuto && !Array.isArray(body.slots)) {
      return NextResponse.json(
        { error: "slots array is required for manual allocation" },
        { status: 400 }
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
        { status: 404 }
      );
    }

    // Validate user information
    if (!subscription.subscriptionPlan?.consultantProfile?.user?.id || !subscription.requestedBy?.user?.id) {
      return NextResponse.json(
        { error: "Missing user information" },
        { status: 400 }
      );
    }

    try {
      // Use transaction to ensure atomic updates
      const result = await prisma.$transaction(async (tx) => {
        // Get slots based on allocation method
        const selectedSlots = body.isAuto
          ? await allocateSlotsAuto(subscription, tx)
          : await allocateSlotsManual(subscription, body.slots!, tx);

        // Create appointments for selected slots
        const appointments = await Promise.all(
          selectedSlots.map((slotTime) =>
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
                        { id: subscription.subscriptionPlan.consultantProfile.user.id },
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
            })
          )
        );

        // Update subscription status
        const updatedSubscription = await tx.subscription.update({
          where: { id: subscriptionId },
          data: {
            requestStatus: RequestStatus.APPROVED,
            startDate: selectedSlots[0],
            endDate: addWeeks(selectedSlots[0], subscription.subscriptionPlan.durationInMonths * 4),
          },
          include: subscriptionInclude,
        });

        return {
          subscription: updatedSubscription,
          appointments,
        };
      });

      return NextResponse.json({ data: result });
    } catch (error) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Failed to allocate slots",
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Error in slot allocation:", error);
    return NextResponse.json(
      { error: "An error occurred during slot allocation" },
      { status: 500 }
    );
  }
}
