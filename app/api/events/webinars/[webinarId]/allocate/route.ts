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
  useRequestedSlots?: boolean; // For using pre-allocated slots
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
  tx: PrismaTransaction
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
        slot.slotStartTimeInUTC.toISOString()
      )
    )
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
            0
          );

          if (candidateSlot >=now ) {
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
      if (bookedSlots.has(slotTime.toISOString()) || slotTime < now) {
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
  tx: PrismaTransaction
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
  tx: PrismaTransaction
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
        `Slot ${slotDate.toLocaleString()} does not match consultant's weekly schedule`
      );
    }
  } else {
    // For custom schedule, validate slot exists in custom slots
    const availableCustomSlots =
      consultantProfile.slotsOfAvailabilityCustom.some(
        (slot) =>
          new Date(slot.slotStartTimeInUTC).toISOString() ===
          slotDate.toISOString()
      );

    if (!availableCustomSlots) {
      throw new Error(
        `Slot ${slotDate.toLocaleString()} is not in consultant's custom schedule`
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
  { params }: { params: Promise<{ webinarId: string }> }
) {
  try {
    const { webinarId } = await params;
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
        { status: 400 }
      );
    }

    const { consultantProfile } = webinar.webinarPlan;
    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 400 }
      );
    }

    try {
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
                  webinar.webinarPlan.durationInHours
                ),
                isTentative: false,
                user: {
                  connect: [
                    {
                      id: (() => {
                        if (!webinar.webinarPlan.consultantProfile?.user?.id) {
                          throw new Error(
                            "Missing consultant user information"
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
    } catch (error) {
      if (error instanceof Error) {
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
      console.error("Error: ", error.stack);
    }
    return NextResponse.json(
      { error: "An error occurred during slot allocation" },
      { status: 500 }
    );
  }
}
