import prisma from "@/lib/prisma";
import { RequestStatus, ScheduleType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

interface ValidationRequest {
  slots: string[];
}

interface ValidationResult {
  conflicts: {
    slot: string;
    existingAppointment: {
      type: string;
      with: string;
      time: string;
    };
  }[];
  outsideAvailability: {
    slot: string;
  }[];
  validSlots: string[];
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
} as const;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> }
) {
  try {
    const { webinarId } = await params;
    const body: ValidationRequest = await request.json();

    // Validate slots array exists
    if (!Array.isArray(body.slots) || body.slots.length === 0) {
      return NextResponse.json(
        { error: "Slots array is required and must not be empty" },
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

    const { webinarPlan } = webinar;
    const { consultantProfile } = webinarPlan;

    // Calculate required slots based on webinar duration
    const webinarDuration = webinarPlan.durationInHours || 1;
    const requiredSlots = Math.ceil(webinarDuration * 2); // 2 slots per hour (30-min each)

    // Validate correct number of slots
    if (body.slots.length !== requiredSlots) {
      const durationText = `${webinarDuration} hour${webinarDuration > 1 ? "s" : ""}`;
      return NextResponse.json(
        {
          error: `Webinar (${durationText}) requires exactly ${requiredSlots} consecutive slot${requiredSlots > 1 ? "s" : ""}`,
        },
        { status: 400 }
      );
    }

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 400 }
      );
    }

    // Initialize validation result
    const result: ValidationResult = {
      conflicts: [],
      outsideAvailability: [],
      validSlots: [],
    };

    // Convert slots to Date objects
    const slotDates = body.slots.map((slot) => new Date(slot));

    // Validate slots are not in the past
    const now = new Date();
    const pastSlots = slotDates.filter((slot) => slot <= now);
    if (pastSlots.length > 0) {
      return NextResponse.json(
        { error: "Cannot validate slots in the past" },
        { status: 400 }
      );
    }

    // For multi-slot webinars, validate that slots are consecutive
    if (requiredSlots > 1) {
      const sortedSlots = [...slotDates].sort(
        (a, b) => a.getTime() - b.getTime()
      );
      for (let i = 1; i < sortedSlots.length; i++) {
        const prevSlot = sortedSlots[i - 1];
        const currentSlot = sortedSlots[i];
        const expectedStartTime = new Date(prevSlot.getTime() + 30 * 60 * 1000); // 30 minutes later
        if (currentSlot.getTime() !== expectedStartTime.getTime()) {
          return NextResponse.json(
            { error: "Webinar slots must be consecutive" },
            { status: 400 }
          );
        }
      }
    }

    // Check for conflicts with existing approved appointments
    const existingAppointments = await prisma.appointment.findMany({
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
                slotStartTimeInUTC: {
                  in: slotDates,
                },
              },
            },
          },
        ],
      },
      include: {
        subscription: {
          include: {
            requestedBy: {
              include: {
                user: true,
              },
            },
          },
        },
        consultation: {
          include: {
            requestedBy: {
              include: {
                user: true,
              },
            },
          },
        },
        webinar: {
          include: {
            webinarPlan: true,
          },
        },
        class: {
          include: {
            classPlan: true,
          },
        },
        slotsOfAppointment: {
          include: {
            user: true,
          },
        },
      },
    });

    // Process conflicts
    for (const appointment of existingAppointments) {
      const conflictingSlots = appointment.slotsOfAppointment.filter((slot) =>
        slotDates.some(
          (date) => date.toISOString() === slot.slotStartTimeInUTC.toISOString()
        )
      );

      for (const slot of conflictingSlots) {
        let appointmentType = "Unknown";
        let withUser = "Unknown";

        if (appointment.subscription) {
          appointmentType = "Subscription";
          withUser =
            appointment.subscription.requestedBy?.user?.name || "Unknown";
        } else if (appointment.consultation) {
          appointmentType = "Consultation";
          withUser =
            appointment.consultation.requestedBy?.user?.name || "Unknown";
        } else if (appointment.webinar) {
          appointmentType = "Webinar";
          withUser = appointment.webinar.webinarPlan?.title || "Unknown";
        } else if (appointment.class) {
          appointmentType = "Class";
          withUser = appointment.class.classPlan?.title || "Unknown";
        }

        result.conflicts.push({
          slot: slot.slotStartTimeInUTC.toISOString(),
          existingAppointment: {
            type: appointmentType,
            with: withUser,
            time: new Date(slot.slotStartTimeInUTC).toLocaleString(),
          },
        });
      }
    }

    // Check if slots are within consultant's availability
    const availableSlots =
      consultantProfile.scheduleType === ScheduleType.WEEKLY
        ? consultantProfile.slotsOfAvailabilityWeekly
        : consultantProfile.slotsOfAvailabilityCustom;

    for (const slotDate of slotDates) {
      let isAvailable = false;

      if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
        // For weekly schedule, check if the slot matches any weekly pattern
        isAvailable = availableSlots.some((slot) => {
          const slotTime = new Date(slot.slotStartTimeInUTC);
          return (
            slotDate.getDay() === slotTime.getDay() &&
            slotDate.getHours() === slotTime.getHours() &&
            slotDate.getMinutes() === slotTime.getMinutes()
          );
        });
      } else {
        // For custom schedule, check if the slot exists exactly
        isAvailable = availableSlots.some(
          (slot) =>
            new Date(slot.slotStartTimeInUTC).toISOString() ===
            slotDate.toISOString()
        );
      }

      if (!isAvailable) {
        result.outsideAvailability.push({
          slot: slotDate.toISOString(),
        });
      }
    }

    // Valid slots are those without conflicts and within availability
    result.validSlots = slotDates
      .filter((date) => {
        const dateStr = date.toISOString();
        return (
          !result.conflicts.some((c) => c.slot === dateStr) &&
          !result.outsideAvailability.some((o) => o.slot === dateStr)
        );
      })
      .map((date) => date.toISOString());

    return NextResponse.json({ data: result });
  } catch (error) {
    console.error("Webinar validation error:", error);
    return NextResponse.json(
      { error: "Failed to validate webinar slot" },
      { status: 500 }
    );
  }
}
