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
  weeklyDistributionErrors: {
    week: string;
    slotsCount: number;
    maxAllowed: number;
  }[];
}

const classInclude = {
  classPlan: {
    include: {
      classContents: true,
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
  { params }: { params: Promise<{ classId: string }> }
) {
  try {
    const { classId } = await params;
    const body: ValidationRequest = await request.json();

    // Validate slots array
    if (!Array.isArray(body.slots) || body.slots.length === 0) {
      return NextResponse.json(
        { error: "Slots array is required and must not be empty" },
        { status: 400 }
      );
    }

    // Fetch class with necessary relations
    const classPlan = await prisma.class.findUnique({
      where: { id: classId },
      include: classInclude,
    });

    if (!classPlan) {
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    }

    const { classPlan: plan } = classPlan;
    const { consultantProfile } = plan;

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
      weeklyDistributionErrors: [],
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

    // Check for slots outside availability
    if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
      // UTC-aware range-based weekly availability check
      const dayEnumByUtcIndex: any[] = [
        "SUNDAY",
        "MONDAY",
        "TUESDAY",
        "WEDNESDAY",
        "THURSDAY",
        "FRIDAY",
        "SATURDAY",
      ];

      const rangesByDow = new Map<
        string,
        Array<{ start: number; end: number }>
      >();
      consultantProfile.slotsOfAvailabilityWeekly.forEach((ws: any) => {
        const start = new Date(ws.slotStartTimeInUTC);
        const end = new Date(ws.slotEndTimeInUTC);
        const startMinutes = start.getUTCHours() * 60 + start.getUTCMinutes();
        const endMinutes = end.getUTCHours() * 60 + end.getUTCMinutes();
        const dow: string = ws.dayOfWeekforStartTimeInUTC;
        const arr = rangesByDow.get(dow) || [];
        arr.push({ start: startMinutes, end: endMinutes });
        rangesByDow.set(dow, arr);
      });

      for (const slotDate of slotDates) {
        const dow = dayEnumByUtcIndex[slotDate.getUTCDay()];
        const startMinutes =
          slotDate.getUTCHours() * 60 + slotDate.getUTCMinutes();
        const endMinutes = startMinutes + 30;
        const ranges = rangesByDow.get(dow) || [];
        const withinAnyRange = ranges.some(
          (r) => startMinutes >= r.start && endMinutes <= r.end
        );
        if (!withinAnyRange) {
          result.outsideAvailability.push({ slot: slotDate.toISOString() });
        }
      }
    } else {
      // For custom schedule, check if the slot exists exactly
      const availableSlots = consultantProfile.slotsOfAvailabilityCustom;
      for (const slotDate of slotDates) {
        const isAvailable = availableSlots.some(
          (slot: any) =>
            new Date(slot.slotStartTimeInUTC).toISOString() ===
            slotDate.toISOString()
        );
        if (!isAvailable) {
          result.outsideAvailability.push({ slot: slotDate.toISOString() });
        }
      }
    }

    // Validate weekly distribution for classes (if applicable)
    if (plan.callsPerWeek) {
      // Calculate session duration from class contents (same logic as allocation route)
      const classContents = plan.classContents || [];
      let sessionDurationInHours = 1; // Default
      if (classContents.length > 0) {
        const totalHours = classContents.reduce(
          (sum, content) => sum + content.hoursAllotted,
          0
        );
        sessionDurationInHours = totalHours / classContents.length;
      }

      const slotsPerSession = Math.ceil(sessionDurationInHours / 0.5); // 30-min slots
      const maxSlotsPerWeek = plan.callsPerWeek * slotsPerSession;

      const slotsByWeek = new Map<string, number>();

      for (const slotDate of slotDates) {
        const weekStart = new Date(slotDate);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Get start of week (Sunday)
        weekStart.setHours(0, 0, 0, 0); // Set to start of day
        const weekKey = weekStart.toISOString();
        slotsByWeek.set(weekKey, (slotsByWeek.get(weekKey) || 0) + 1);
      }

      for (const [weekKey, count] of Array.from(slotsByWeek.entries())) {
        if (count > maxSlotsPerWeek) {
          result.weeklyDistributionErrors.push({
            week: new Date(weekKey).toLocaleDateString(),
            slotsCount: count,
            maxAllowed: maxSlotsPerWeek,
          });
        }
      }
    }

    // Valid slots are those without conflicts, within availability, and following distribution rules
    result.validSlots = slotDates
      .filter((date) => {
        const dateStr = date.toISOString();
        return (
          !result.conflicts.some((c) => c.slot === dateStr) &&
          !result.outsideAvailability.some((o) => o.slot === dateStr)
        );
      })
      .map((date) => date.toISOString());

    // If there are weekly distribution errors, no slots are valid
    if (result.weeklyDistributionErrors.length > 0) {
      result.validSlots = [];
    }

    return NextResponse.json({ data: result });
  } catch (error) {
    console.error("Class validation error:", error);
    return NextResponse.json(
      { error: "Failed to validate class slots" },
      { status: 500 }
    );
  }
}
