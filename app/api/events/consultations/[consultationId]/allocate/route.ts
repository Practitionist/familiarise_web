import prisma from "@/lib/prisma";
import {
  AppointmentsType,
  Prisma,
  RequestStatus,
  ScheduleType,
} from "@prisma/client";
import { addHours } from "date-fns";
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

const consultationInclude = {
  consultationPlan: {
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
  appointment: {
    include: {
      slotsOfAppointment: true,
    },
  },
} as const;

type ConsultationWithRelations = Prisma.ConsultationGetPayload<{
  include: typeof consultationInclude;
}>;

// FIXED: Helper functions to reduce code duplication
function calculateRequiredSlots(durationInHours: number): number {
  return Math.ceil(durationInHours / 0.5); // 30-minute intervals
}

function validateSlotCount(
  selectedSlots: Date[],
  requiredSlots: number,
  durationInHours: number
): void {
  if (selectedSlots.length !== requiredSlots) {
    throw new Error(
      `Maximum ${requiredSlots} slots allowed for this consultation (${durationInHours} hour${durationInHours > 1 ? "s" : ""})`
    );
  }
}

function validateSlotsNotInPast(slots: Date[]): void {
  const now = new Date();
  for (const slot of slots) {
    if (slot <= now) {
      throw new Error("Cannot allocate slots in the past");
    }
  }
}

function validateSlotsSameDay(slots: Date[]): void {
  if (slots.length <= 1) return;

  const firstSlotDay = slots[0].toDateString();
  for (const slot of slots) {
    if (slot.toDateString() !== firstSlotDay) {
      throw new Error(
        "Consultation is a one-day event - all slots must be on the same day"
      );
    }
  }
}

function validateSlotsConsecutive(slots: Date[]): void {
  if (slots.length <= 1) return;

  const sortedSlots = slots.sort((a, b) => a.getTime() - b.getTime());
  const toleranceMs = 1000; // 1 second tolerance for timezone/precision issues

  for (let i = 1; i < sortedSlots.length; i++) {
    const prevSlot = sortedSlots[i - 1];
    const currentSlot = sortedSlots[i];

    // Add 30 minutes (0.5 hours) to previous slot end time
    const expectedNextSlotTime = new Date(prevSlot.getTime() + 30 * 60 * 1000);

    const timeDiff = Math.abs(
      currentSlot.getTime() - expectedNextSlotTime.getTime()
    );

    if (timeDiff > toleranceMs) {
      throw new Error(
        "Consultation slots must be consecutive (no gaps between slots)"
      );
    }
  }
}

async function validateSlotAvailability(
  slots: Date[],
  tx: PrismaTransaction,
  consultantId: string,
  requestedById: string
): Promise<void> {
  for (const slot of slots) {
    const existingAppointment = await tx.appointment.findFirst({
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
              some: { slotStartTimeInUTC: slot },
            },
          },
        ],
      },
    });

    if (existingAppointment) {
      throw new Error(
        `Selected slot ${slot.toLocaleString()} is already booked`
      );
    }
  }
}

function validateSlotMatchesSchedule(
  firstSlot: Date,
  consultantProfile: any
): void {
  if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
    // For weekly schedule, validate first slot follows the weekly pattern
    const availableWeeklySlots =
      consultantProfile.slotsOfAvailabilityWeekly.some((slot: any) => {
        const slotDay = new Date(slot.slotStartTimeInUTC).getDay();
        const slotHours = new Date(slot.slotStartTimeInUTC).getHours();
        const slotMinutes = new Date(slot.slotStartTimeInUTC).getMinutes();

        return (
          firstSlot.getDay() === slotDay &&
          firstSlot.getHours() === slotHours &&
          firstSlot.getMinutes() === slotMinutes
        );
      });

    if (!availableWeeklySlots) {
      throw new Error(
        `First slot ${firstSlot.toLocaleString()} does not match consultant's weekly schedule`
      );
    }
  } else {
    // For custom schedule, validate first slot exists in custom slots
    const availableCustomSlots =
      consultantProfile.slotsOfAvailabilityCustom.some(
        (slot: any) =>
          new Date(slot.slotStartTimeInUTC).toISOString() ===
          firstSlot.toISOString()
      );

    if (!availableCustomSlots) {
      throw new Error(
        `First slot ${firstSlot.toLocaleString()} is not in consultant's custom schedule`
      );
    }
  }
}

// FIXED: Comprehensive validation function with proper order
async function validateConsultationSlots(
  slots: Date[],
  consultation: ConsultationWithRelations,
  tx: PrismaTransaction
): Promise<void> {
  const requiredSlots = calculateRequiredSlots(
    consultation.consultationPlan.durationInHours
  );

  // 1. First validate slot count
  validateSlotCount(
    slots,
    requiredSlots,
    consultation.consultationPlan.durationInHours
  );

  // 2. Validate slots are not in the past
  validateSlotsNotInPast(slots);

  // 3. Validate all slots are on the same day (MOST IMPORTANT - check this FIRST)
  validateSlotsSameDay(slots);

  // 4. Only then validate slots are consecutive (only if same-day check passes)
  validateSlotsConsecutive(slots);

  // 5. Validate first slot matches consultant's schedule
  if (slots.length > 0) {
    validateSlotMatchesSchedule(
      slots[0],
      consultation.consultationPlan.consultantProfile
    );
  }

  // 6. Validate slot availability (conflicts)
  await validateSlotAvailability(
    slots,
    tx,
    consultation.consultationPlan.consultantProfile.user.id,
    consultation.requestedBy.user.id
  );
}

async function allocateSlotAuto(
  consultation: ConsultationWithRelations,
  tx: PrismaTransaction
): Promise<Date[]> {
  const { consultationPlan, requestedBy } = consultation;
  const { consultantProfile } = consultationPlan;

  if (!consultantProfile) {
    throw new Error("Consultant profile not found");
  }

  const requiredSlots = calculateRequiredSlots(
    consultationPlan.durationInHours
  );

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
      app.slotsOfAppointment.map((slot: { slotStartTimeInUTC: Date }) =>
        slot.slotStartTimeInUTC.toISOString()
      )
    )
  );

  // Find consecutive available slots
  const now = new Date();
  for (const slot of sortedSlots) {
    let firstSlotTime: Date;

    if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
      // For weekly slots, find the next occurrence of this weekday
      const slotDate = new Date();
      const currentDay = slotDate.getDay();
      const targetDay = new Date(slot.slotStartTimeInUTC).getDay();
      const daysToAdd = (targetDay - currentDay + 7) % 7;
      slotDate.setDate(slotDate.getDate() + daysToAdd);
      slotDate.setHours(
        new Date(slot.slotStartTimeInUTC).getHours(),
        new Date(slot.slotStartTimeInUTC).getMinutes(),
        0,
        0
      );
      firstSlotTime = slotDate;
    } else {
      // For custom slots, use the exact date
      firstSlotTime = new Date(slot.slotStartTimeInUTC);
    }

    // Skip if first slot is already booked or in the past
    if (bookedSlots.has(firstSlotTime.toISOString()) || firstSlotTime < now) {
      continue;
    }

    // FIXED: Check if we have enough consecutive slots starting from this time
    // Use tolerance for timezone/precision issues
    const consecutiveSlots: Date[] = [];
    let currentSlotTime = new Date(firstSlotTime);
    const toleranceMs = 1000; // 1 second tolerance

    for (let i = 0; i < requiredSlots; i++) {
      const slotTime = new Date(currentSlotTime);

      // Skip if this slot is already booked or in the past
      if (bookedSlots.has(slotTime.toISOString()) || slotTime < now) {
        break;
      }

      consecutiveSlots.push(slotTime);

      // Calculate next slot time with tolerance for precision issues
      const nextSlotTime = new Date(slotTime.getTime() + 30 * 60 * 1000);
      currentSlotTime = nextSlotTime;
    }

    // If we found enough consecutive slots, validate and return them
    if (consecutiveSlots.length === requiredSlots) {
      await validateConsultationSlots(consecutiveSlots, consultation, tx);
      return consecutiveSlots;
    }
  }

  throw new Error(
    "No available consecutive slots found for consultation duration"
  );
}

async function allocateSlotRequested(
  consultation: ConsultationWithRelations,
  tx: PrismaTransaction
): Promise<Date[]> {
  const requestedSlots = consultation.appointment?.slotsOfAppointment;
  if (!requestedSlots || requestedSlots.length === 0) {
    throw new Error("No requested slots found");
  }

  const selectedSlots = requestedSlots.map(
    (slot) => new Date(slot.slotStartTimeInUTC)
  );

  // Use the comprehensive validation function
  await validateConsultationSlots(selectedSlots, consultation, tx);

  return selectedSlots;
}

async function allocateSlotManual(
  consultation: ConsultationWithRelations,
  slots: string[],
  tx: PrismaTransaction
): Promise<Date[]> {
  const slotDates = slots.map((slot) => new Date(slot));

  // Use the comprehensive validation function
  await validateConsultationSlots(slotDates, consultation, tx);

  return slotDates;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ consultationId: string }> }
) {
  try {
    const { consultationId } = await params;
    const body: AllocationRequest = await request.json();

    // Validate request body
    if (typeof body.isAuto !== "boolean") {
      return NextResponse.json(
        { error: "isAuto flag is required" },
        { status: 400 }
      );
    }

    if (body.useRequestedSlots) {
      // When using requested slots, we don't need manual slots
      body.isAuto = false;
    } else if (!body.isAuto && !Array.isArray(body.slots)) {
      return NextResponse.json(
        { error: "slots array is required for manual allocation" },
        { status: 400 }
      );
    }

    // Fetch consultation with necessary relations
    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
      include: consultationInclude,
    });

    if (!consultation) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 }
      );
    }

    // Validate user information
    if (
      !consultation.consultationPlan?.consultantProfile?.user?.id ||
      !consultation.requestedBy?.user?.id
    ) {
      return NextResponse.json(
        { error: "Missing user information" },
        { status: 400 }
      );
    }

    const { consultantProfile } = consultation.consultationPlan;
    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 400 }
      );
    }

    // Check if consultation is already approved
    if (consultation.requestStatus === RequestStatus.APPROVED) {
      return NextResponse.json(
        { error: "Consultation is already approved" },
        { status: 400 }
      );
    }

    try {
      // Use transaction to ensure atomic updates
      const result = await prisma.$transaction(async (tx) => {
        // If using requested slots and appointment exists, just approve the consultation
        if (body.useRequestedSlots && consultation.appointment) {
          const requestedSlots = consultation.appointment.slotsOfAppointment;
          if (!requestedSlots || requestedSlots.length === 0) {
            throw new Error("No requested slots found");
          }

          const selectedSlots = requestedSlots.map(
            (slot) => new Date(slot.slotStartTimeInUTC)
          );

          // Use the comprehensive validation function
          await validateConsultationSlots(selectedSlots, consultation, tx);

          // Just approve the consultation
          const updatedConsultation = await tx.consultation.update({
            where: { id: consultationId },
            data: {
              requestStatus: RequestStatus.APPROVED,
            },
            include: consultationInclude,
          });

          return {
            consultation: updatedConsultation,
            appointment: consultation.appointment,
          };
        }

        // For auto/manual allocation, delete existing appointment if any
        if (!body.useRequestedSlots && consultation.appointment) {
          await tx.appointment.delete({
            where: { id: consultation.appointment.id },
          });
        }

        // Get slot based on allocation method
        let selectedSlots: Date[];
        if (body.useRequestedSlots) {
          selectedSlots = await allocateSlotRequested(consultation, tx);
        } else if (body.isAuto) {
          selectedSlots = await allocateSlotAuto(consultation, tx);
        } else {
          selectedSlots = await allocateSlotManual(
            consultation,
            body.slots!,
            tx
          );
        }

        // FIXED: Create appointment with multiple slots for consultations
        const appointment = await tx.appointment.create({
          data: {
            appointmentType: AppointmentsType.CONSULTATION,
            consultation: {
              connect: { id: consultationId },
            },
            slotsOfAppointment: {
              create: selectedSlots.map((slotStartTime, index) => ({
                slotStartTimeInUTC: slotStartTime,
                slotEndTimeInUTC: new Date(
                  slotStartTime.getTime() + 30 * 60 * 1000
                ), // 30 minutes per slot
                isTentative: false,
                user: {
                  connect: [
                    { id: consultation.requestedBy.user.id },
                    {
                      id: consultation.consultationPlan.consultantProfile.user
                        .id,
                    },
                  ],
                },
              })),
            },
          },
          include: {
            slotsOfAppointment: {
              include: {
                user: true,
              },
            },
          },
        });

        // Update consultation status
        const updatedConsultation = await tx.consultation.update({
          where: { id: consultationId },
          data: {
            requestStatus: RequestStatus.APPROVED,
          },
          include: consultationInclude,
        });

        return {
          consultation: updatedConsultation,
          appointment,
        };
      });

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
            error instanceof Error ? error.message : "Failed to allocate slot",
        },
        { status: 500 }
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
      { status: 500 }
    );
  }
}
