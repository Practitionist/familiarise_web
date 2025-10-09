/**
 * Webinar Slot Allocation API Route
 *
 * NOTE: This route uses inline allocation logic (not yet refactored to SlotAllocationService)
 * Consider refactoring to use unified SlotAllocationService in the future.
 *
 * VALIDATION LAYERS:
 * 1. Zod schema validation - Type-safe validation with automatic type inference
 * 2. Inline business logic - Validates availability and conflicts
 */

import prisma from "@/lib/prisma";
import {
  AppointmentsType,
  Prisma,
  RequestStatus,
  ScheduleType,
} from "@prisma/client";
import { addHours } from "date-fns";
import { NextRequest, NextResponse } from "next/server";
import {
  allocationRequestSchema,
  eventIdSchema,
} from "@/schemas/slotAllocation/validationSchemas";
import { ZodError } from "zod";

type PrismaTransaction = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use"
>;

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
): Promise<Date> {
  const { webinarPlan } = webinar;
  const { consultantProfile } = webinarPlan;

  if (!consultantProfile) {
    throw new Error("Consultant profile not found");
  }

  // Validate number of slots
  if (slots.length !== 1) {
    throw new Error("Webinar requires exactly one slot");
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
  { params }: { params: Promise<{ webinarId: string }> },
) {
  try {
    const { webinarId } = await params;

    // LAYER 1: Zod Schema Validation (type-safe, automatic type inference)
    try {
      // Validate webinar ID from URL params
      eventIdSchema.parse(webinarId);

      // Validate request body and get typed data
      const body = allocationRequestSchema.parse(await request.json());

      if (body.useRequestedSlots) {
        // When using requested slots, we don't need manual slots
        body.isAuto = false;
      }

      // Fetch webinar with necessary relations
      const webinar = await prisma.webinar.findUnique({
        where: { id: webinarId },
        include: webinarInclude,
      });

      if (!webinar) {
        return NextResponse.json(
          { error: "Webinar not found" },
          { status: 404 },
        );
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

      // LAYER 2: Business Logic - Inline allocation and validation
      // Use transaction to ensure atomic updates
      const result = await prisma.$transaction(async (tx) => {
        // If using requested slots and appointment exists, just update status
        if (body.useRequestedSlots && webinar.appointment) {
          // Validate the slot is still available
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
                    some: {
                      slotStartTimeInUTC:
                        webinar.appointment.slotsOfAppointment[0]
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

        // Get slot based on allocation method
        let selectedSlot;
        if (body.useRequestedSlots) {
          selectedSlot = await allocateSlotRequested(webinar, tx);
        } else if (body.isAuto) {
          selectedSlot = await allocateSlotAuto(webinar, tx);
        } else {
          selectedSlot = await allocateSlotManual(webinar, body.slots!, tx);
        }

        // Create appointment for selected slot
        const appointment = await tx.appointment.create({
          data: {
            appointmentType: AppointmentsType.WEBINAR,
            webinar: {
              connect: { id: webinarId },
            },
            slotsOfAppointment: {
              create: {
                slotStartTimeInUTC: selectedSlot,
                slotEndTimeInUTC: addHours(
                  selectedSlot,
                  webinar.webinarPlan.durationInHours,
                ),
                isTentative: false,
                user: {
                  connect: [
                    {
                      id: (() => {
                        if (!webinar.webinarPlan.consultantProfile?.user?.id) {
                          throw new Error(
                            "Missing consultant user information",
                          );
                        }
                        return webinar.webinarPlan.consultantProfile.user.id;
                      })(),
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
    } catch (validationError) {
      // Zod validation errors - return 400 Bad Request
      if (validationError instanceof ZodError) {
        const errorMessage = validationError.errors
          .map((err) => `${err.path.join(".")}: ${err.message}`)
          .join("; ");

        return NextResponse.json({ error: errorMessage }, { status: 400 });
      }
      throw validationError; // Re-throw non-validation errors
    }
  } catch (error) {
    // Catch-all for unexpected errors (database errors, network issues, etc.)
    if (error instanceof Error) {
      console.error("Error: ", error.stack);
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "An error occurred during slot allocation",
      },
      { status: 500 },
    );
  }
}
