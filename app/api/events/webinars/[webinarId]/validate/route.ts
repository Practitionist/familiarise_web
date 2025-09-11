import prisma from "@/lib/prisma";
import { RequestStatus, ScheduleType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import {
  getSlotBookingStatus,
  hasTimeOverlap,
} from "@/utils/timeSlotsProcessing";

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
      return NextResponse.json(
        {
          error: `This webinar requires only ${requiredSlots} slots`,
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

    // Check for conflicts with existing approved appointments using overlap logic
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
                // Check for overlaps using the same logic as availability API
                OR: slotDates.flatMap((slotStart) => {
                  const slotEnd = new Date(
                    slotStart.getTime() + 30 * 60 * 1000
                  ); // 30-minute slots
                  return [
                    {
                      AND: [
                        { slotStartTimeInUTC: { lte: slotStart } },
                        { slotEndTimeInUTC: { gt: slotStart } },
                      ],
                    },
                    {
                      AND: [
                        { slotStartTimeInUTC: { lt: slotEnd } },
                        { slotEndTimeInUTC: { gte: slotEnd } },
                      ],
                    },
                    {
                      AND: [
                        { slotStartTimeInUTC: { gte: slotStart } },
                        { slotEndTimeInUTC: { lte: slotEnd } },
                      ],
                    },
                  ];
                }),
              },
            },
          },
          // CRITICAL FIX: Exclude the current webinar being validated from conflict check
          {
            NOT: {
              webinar: {
                id: webinarId,
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

    // Process conflicts using booking status logic (same as availability API)
    for (const slotDate of slotDates) {
      const slotStart = slotDate;
      const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000); // 30-minute slots

      // Get all appointment slots that overlap with this specific slot
      const overlappingSlots: Array<{
        slotStartTimeInUTC: Date;
        slotEndTimeInUTC: Date;
      }> = [];
      existingAppointments.forEach((appointment) => {
        appointment.slotsOfAppointment.forEach((slot) => {
          if (
            hasTimeOverlap(
              slotStart,
              slotEnd,
              slot.slotStartTimeInUTC,
              slot.slotEndTimeInUTC
            )
          ) {
            overlappingSlots.push(slot);
          }
        });
      });

      // Use the same booking status logic as availability API
      const bookingStatus = getSlotBookingStatus(
        slotStart,
        slotEnd,
        overlappingSlots.map((slot) => ({
          slotStartTimeInUTC: slot.slotStartTimeInUTC,
          slotEndTimeInUTC: slot.slotEndTimeInUTC,
        }))
      );

      // Only report as conflict if slot is fully booked (same threshold as availability API)
      if (bookingStatus === "fully-booked") {
        // Find the appointment that makes this slot fully booked
        const conflictingAppointment = existingAppointments.find(
          (appointment) =>
            appointment.slotsOfAppointment.some((slot) =>
              hasTimeOverlap(
                slotStart,
                slotEnd,
                slot.slotStartTimeInUTC,
                slot.slotEndTimeInUTC
              )
            )
        );

        if (conflictingAppointment) {
          let appointmentType = "Unknown";
          let withUser = "Unknown";

          if (conflictingAppointment.subscription) {
            appointmentType = "Subscription";
            withUser =
              conflictingAppointment.subscription.requestedBy?.user?.name ||
              "Unknown";
          } else if (conflictingAppointment.consultation) {
            appointmentType = "Consultation";
            withUser =
              conflictingAppointment.consultation.requestedBy?.user?.name ||
              "Unknown";
          } else if (conflictingAppointment.webinar) {
            appointmentType = "Webinar";
            withUser =
              conflictingAppointment.webinar.webinarPlan?.title || "Unknown";
          } else if (conflictingAppointment.class) {
            appointmentType = "Class";
            withUser =
              conflictingAppointment.class.classPlan?.title || "Unknown";
          }

          result.conflicts.push({
            slot: slotDate.toISOString(),
            existingAppointment: {
              type: appointmentType,
              with: withUser,
              time: slotDate.toLocaleString(),
            },
          });
        }
      }
    }

    // Check if slots are within consultant's availability
    if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
      // Build merged ranges (minutes-of-day) for the UTC weekday of each slot
      const dayToNum: Record<string, number> = {
        SUNDAY: 0,
        MONDAY: 1,
        TUESDAY: 2,
        WEDNESDAY: 3,
        THURSDAY: 4,
        FRIDAY: 5,
        SATURDAY: 6,
      };

      // Group weekly windows by day as [startMin,endMin] and merge contiguous/overlapping
      const windowsByDay: Map<
        number,
        Array<{ start: number; end: number }>
      > = new Map();
      for (const ws of consultantProfile.slotsOfAvailabilityWeekly) {
        const dow =
          dayToNum[ws.dayOfWeekforStartTimeInUTC as keyof typeof dayToNum];
        const start = new Date(ws.slotStartTimeInUTC);
        const end = new Date(ws.slotEndTimeInUTC);
        const startMin = start.getUTCHours() * 60 + start.getUTCMinutes();
        const endMin = end.getUTCHours() * 60 + end.getUTCMinutes();
        if (!windowsByDay.has(dow)) windowsByDay.set(dow, []);
        windowsByDay.get(dow)!.push({ start: startMin, end: endMin });
      }
      // Merge per day
      windowsByDay.forEach((ranges, dow) => {
        ranges.sort((a, b) => a.start - b.start);
        const merged: Array<{ start: number; end: number }> = [];
        for (const r of ranges) {
          const last = merged[merged.length - 1];
          if (!last) {
            merged.push({ ...r });
          } else if (r.start <= last.end) {
            // overlap or contiguous
            last.end = Math.max(last.end, r.end);
          } else {
            merged.push({ ...r });
          }
        }
        windowsByDay.set(dow, merged);
      });

      for (const slotDate of slotDates) {
        const dow = slotDate.getUTCDay();
        const ranges = windowsByDay.get(dow) || [];
        const startMin = slotDate.getUTCHours() * 60 + slotDate.getUTCMinutes();
        const endMin = startMin + 30; // 30-min slot
        const within = ranges.some(
          (r) => startMin >= r.start && endMin <= r.end
        );
        if (!within) {
          result.outsideAvailability.push({ slot: slotDate.toISOString() });
        }
      }
    } else {
      const availableSlots = consultantProfile.slotsOfAvailabilityCustom;
      for (const slotDate of slotDates) {
        const isAvailable = availableSlots.some(
          (slot) =>
            new Date(slot.slotStartTimeInUTC).toISOString() ===
            slotDate.toISOString()
        );
        if (!isAvailable) {
          result.outsideAvailability.push({ slot: slotDate.toISOString() });
        }
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
