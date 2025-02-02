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

async function allocateSlotAuto(
  consultation: ConsultationWithRelations,
  tx: PrismaTransaction,
): Promise<Date> {
  const { consultationPlan, requestedBy } = consultation;
  const { consultantProfile } = consultationPlan;
  const consultantTimezone = consultantProfile.user.currentTimezone || "UTC";

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

  // Find first available slot
  const now = new Date();
  for (const slot of sortedSlots) {
    let slotTime: Date;

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
        0,
      );
      slotTime = slotDate;
    } else {
      // For custom slots, use the exact date
      slotTime = new Date(slot.slotStartTimeInUTC);
    }

    // Skip if slot is already booked or in the past
    if (bookedSlots.has(slotTime.toISOString()) || slotTime < now) {
      continue;
    }

    return slotTime;
  }

  throw new Error("No available slots found");
}

async function allocateSlotRequested(
  consultation: ConsultationWithRelations,
  tx: PrismaTransaction,
): Promise<Date> {
  // Get the requested slot from the appointment
  const requestedSlot =
    consultation.appointment?.slotsOfAppointment?.[0]?.slotStartTimeInUTC;
  if (!requestedSlot) {
    throw new Error("No requested slot found");
  }
  const selectedSlot = new Date(requestedSlot);

  // Validate the slot is still available
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
            some: { slotStartTimeInUTC: selectedSlot },
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
  consultation: ConsultationWithRelations,
  slots: string[],
  tx: PrismaTransaction,
): Promise<Date> {
  const { consultationPlan, requestedBy } = consultation;
  const { consultantProfile } = consultationPlan;
  const consultantTimezone = consultantProfile.user.currentTimezone || "UTC";

  // Validate number of slots
  if (slots.length !== 1) {
    throw new Error("Consultation requires exactly one slot");
  }

  const slotDate = new Date(slots[0]);

  // Validate slot is in the future
  if (slotDate <= new Date()) {
    throw new Error("Cannot allocate slots in the past");
  }

  // Validate slot matches consultant's schedule type
  if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
    // For weekly schedule, validate slot follows the weekly pattern
    const availableWeeklySlots =
      consultantProfile.slotsOfAvailabilityWeekly.some((slot) => {
        const slotDay = new Date(slot.slotStartTimeInUTC).getDay();
        const slotHours = new Date(slot.slotStartTimeInUTC).getHours();
        const slotMinutes = new Date(slot.slotStartTimeInUTC).getMinutes();

        return (
          slotDate.getDay() === slotDay &&
          slotDate.getHours() === slotHours &&
          slotDate.getMinutes() === slotMinutes
        );
      });

    if (!availableWeeklySlots) {
      throw new Error(
        `Slot ${slotDate.toLocaleString()} does not match consultant's weekly schedule`,
      );
    }
  } else {
    // For custom schedule, validate slot exists in custom slots
    const availableCustomSlots =
      consultantProfile.slotsOfAvailabilityCustom.some(
        (slot) =>
          new Date(slot.slotStartTimeInUTC).toISOString() ===
          slotDate.toISOString(),
      );

    if (!availableCustomSlots) {
      throw new Error(
        `Slot ${slotDate.toLocaleString()} is not in consultant's custom schedule`,
      );
    }
  }

  // Check for conflicts
  const existingAppointment = await tx.appointment.findFirst({
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
              slotStartTimeInUTC: slotDate,
            },
          },
        },
      ],
    },
  });

  if (existingAppointment) {
    throw new Error("Selected slot is already booked");
  }

  return slotDate;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    const { consultationId } = await params;
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

    // Fetch consultation with necessary relations
    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
      include: consultationInclude,
    });

    if (!consultation) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 },
      );
    }

    // Validate user information
    if (
      !consultation.consultationPlan?.consultantProfile?.user?.id ||
      !consultation.requestedBy?.user?.id
    ) {
      return NextResponse.json(
        { error: "Missing user information" },
        { status: 400 },
      );
    }

    // Check if consultation is already approved
    if (consultation.requestStatus === RequestStatus.APPROVED) {
      return NextResponse.json(
        { error: "Consultation is already approved" },
        { status: 400 },
      );
    }

    try {
      // Use transaction to ensure atomic updates
      const result = await prisma.$transaction(async (tx) => {
        // If using requested slots and appointment exists, just approve the consultation
        if (body.useRequestedSlots && consultation.appointment) {
          // Validate the slot is still available
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
                    some: {
                      slotStartTimeInUTC:
                        consultation.appointment.slotsOfAppointment[0]
                          .slotStartTimeInUTC,
                    },
                  },
                },
              ],
            },
          });

          if (existingAppointment) {
            throw new Error("Requested slot is no longer available");
          }

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
        let selectedSlot;
        if (body.useRequestedSlots) {
          selectedSlot = await allocateSlotRequested(consultation, tx);
        } else if (body.isAuto) {
          selectedSlot = await allocateSlotAuto(consultation, tx);
        } else {
          selectedSlot = await allocateSlotManual(
            consultation,
            body.slots!,
            tx,
          );
        }

        // Create appointment for selected slot
        const appointment = await tx.appointment.create({
          data: {
            appointmentType: AppointmentsType.CONSULTATION,
            consultation: {
              connect: { id: consultationId },
            },
            slotsOfAppointment: {
              create: {
                slotStartTimeInUTC: selectedSlot,
                slotEndTimeInUTC: addHours(
                  selectedSlot,
                  consultation.consultationPlan.durationInHours,
                ),
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
        console.log("Error: ", error.stack);
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
      // Fixes the below error:
      //  ⨯ TypeError: The "payload" argument must be of type object. Received null
      console.log("Error: ", error.stack);
    }
    return NextResponse.json(
      { error: "An error occurred during slot allocation" },
      { status: 500 },
    );
  }
}
