import prisma from "@/lib/prisma";
import {
  AppointmentsType,
  Prisma,
  RequestStatus,
  ScheduleType,
  DayOfWeek,
  SlotOfAvailabilityWeekly,
  SlotOfAvailabilityCustom,
} from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

type PrismaTransaction = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use"
>;

interface AllocationRequest {
  isAuto: boolean;
  slots?: string[]; // Required for manual allocation
  useRequestedSlots?: boolean; // For using consultee's requested slots
  reallocate?: boolean; // If true, allow reallocating even if consultation is approved
  clear?: boolean; // If true, clear existing allocated slots (delete appointment) without deleting consultation
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

// Helper functions to reduce code duplication
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

  const sortedSlots = [...slots].sort((a, b) => a.getTime() - b.getTime());
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
              some: {
                slotStartTimeInUTC: slot,
                // Scope conflicts to appointments involving either the consultant or the requester
                user: {
                  some: {
                    id: { in: [consultantId, requestedById] },
                  },
                },
              },
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
    // For weekly schedule, validate that the first slot's 30-min window falls within
    // any of the weekly availability ranges for that day (UTC-aware).
    const getUtcDayOfWeek = (date: Date): DayOfWeek => {
      const days = [
        DayOfWeek.SUNDAY,
        DayOfWeek.MONDAY,
        DayOfWeek.TUESDAY,
        DayOfWeek.WEDNESDAY,
        DayOfWeek.THURSDAY,
        DayOfWeek.FRIDAY,
        DayOfWeek.SATURDAY,
      ];
      return days[date.getUTCDay()];
    };

    const firstDayEnum = getUtcDayOfWeek(firstSlot);
    const firstMinutesOfDay = firstSlot.getUTCHours() * 60 + firstSlot.getUTCMinutes();
    const firstSlotEndMinutes = firstMinutesOfDay + 30; // 30-min slot window

    // Build ranges (minutes of day) for this weekday using UTC time from stored slots
    const ranges = consultantProfile.slotsOfAvailabilityWeekly
      .filter((slot: any) => slot.dayOfWeekforStartTimeInUTC === firstDayEnum)
      .map((slot: any) => {
        const start = new Date(slot.slotStartTimeInUTC);
        const end = new Date(slot.slotEndTimeInUTC);
        return {
          start: start.getUTCHours() * 60 + start.getUTCMinutes(),
          end: end.getUTCHours() * 60 + end.getUTCMinutes(),
        };
      })
      .sort((a: any, b: any) => a.start - b.start);

    const withinAnyRange = ranges.some((r: { start: number; end: number }) => {
      // Ensure the entire 30-min window is within the configured range
      return firstMinutesOfDay >= r.start && firstSlotEndMinutes <= r.end;
    });

    if (!withinAnyRange) {
      throw new Error(
        `First slot ${firstSlot.toLocaleString()} is outside consultant's weekly availability`
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

// Comprehensive validation function with proper order
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

  // Calculate minimum slots required for this consultation
  const requiredSlots = calculateRequiredSlots(
    consultationPlan.durationInHours
  );

  // Get available slots based on schedule type
  const availableSlots =
    consultantProfile.scheduleType === ScheduleType.WEEKLY
      ? consultantProfile.slotsOfAvailabilityWeekly
      : consultantProfile.slotsOfAvailabilityCustom;

  if (!availableSlots.length) {
    throw new Error(
      "No available slots found for consultant. Please set up your availability schedule first."
    );
  }

  // Do not pre-check availableSlots count against requiredSlots for WEEKLY patterns.
  // We will attempt FCFS consecutive selection directly.

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

  // Sort slots by time of day to prioritize earlier slots (FCFS within a day)
  const sortedSlots = [...availableSlots].sort((a, b) => {
    const timeA =
      new Date(a.slotStartTimeInUTC).getHours() * 60 +
      new Date(a.slotStartTimeInUTC).getMinutes();
    const timeB =
      new Date(b.slotStartTimeInUTC).getHours() * 60 +
      new Date(b.slotStartTimeInUTC).getMinutes();
    return timeA - timeB;
  });

  const now = new Date();

  // Map JS Date.getUTCDay() to Prisma DayOfWeek enum (use UTC to align with DB fields)
  const getUtcDayOfWeek = (date: Date): DayOfWeek => {
    const days = [
      DayOfWeek.SUNDAY,
      DayOfWeek.MONDAY,
      DayOfWeek.TUESDAY,
      DayOfWeek.WEDNESDAY,
      DayOfWeek.THURSDAY,
      DayOfWeek.FRIDAY,
      DayOfWeek.SATURDAY,
    ];
    return days[date.getUTCDay()];
  };
  const getUtcDayKey = (date: Date): string => {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const dnum = date.getUTCDate();
    const dt = new Date(Date.UTC(y, m, dnum, 0, 0, 0, 0));
    return dt.toISOString().split("T")[0];
  };

  // Helper: start of week (Sunday) and end of week (Saturday) for the current week
  const startOfWeekSundayUtc = (d: Date): Date => {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const dayOfMonth = d.getUTCDate();
    const dow = d.getUTCDay();
    const sunday = new Date(Date.UTC(y, m, dayOfMonth - dow, 0, 0, 0, 0));
    return sunday;
  };
  const endOfWeekSaturdayUtc = (d: Date): Date => {
    const start = startOfWeekSundayUtc(d);
    const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
    end.setUTCHours(23, 59, 59, 999);
    return end;
  };

  const weekStartUtc = startOfWeekSundayUtc(now);
  const weekEnd = endOfWeekSaturdayUtc(now);

  // Build fast lookup structures of availability per schedule type
  // WEEKLY: list of time ranges (minutes-of-day) per DayOfWeek
  const weeklyRangesByDow: Map<
    DayOfWeek,
    Array<{ start: number; end: number }>
  > = new Map();
  if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
    for (const ws of consultantProfile.slotsOfAvailabilityWeekly) {
      const dow: DayOfWeek = ws.dayOfWeekforStartTimeInUTC;
      const startMinutes =
        new Date(ws.slotStartTimeInUTC).getUTCHours() * 60 +
        new Date(ws.slotStartTimeInUTC).getUTCMinutes();
      const endMinutes =
        new Date(ws.slotEndTimeInUTC).getUTCHours() * 60 +
        new Date(ws.slotEndTimeInUTC).getUTCMinutes();
      if (!weeklyRangesByDow.has(dow)) weeklyRangesByDow.set(dow, []);
      weeklyRangesByDow
        .get(dow)!
        .push({ start: startMinutes, end: endMinutes });
    }
    // Normalize and sort ranges
    for (const dow of Array.from(weeklyRangesByDow.keys())) {
      const ranges = weeklyRangesByDow.get(dow)!;
      ranges.sort((a, b) => a.start - b.start);
    }
  }
  // CUSTOM: list of ranges per date (UTC day)
  const customRangesByDay: Map<
    string,
    Array<{ start: Date; end: Date }>
  > = new Map();
  if (consultantProfile.scheduleType === ScheduleType.CUSTOM) {
    for (const cs of consultantProfile.slotsOfAvailabilityCustom) {
      const start = new Date(cs.slotStartTimeInUTC);
      const end = new Date(cs.slotEndTimeInUTC);
      const key = getUtcDayKey(start);
      if (!customRangesByDay.has(key)) customRangesByDay.set(key, []);
      customRangesByDay.get(key)!.push({ start, end });
    }
    for (const key of Array.from(customRangesByDay.keys())) {
      const ranges = customRangesByDay.get(key)!;
      ranges.sort((a, b) => a.start.getTime() - b.start.getTime());
    }
  }

  // Iterate days from today through the end of the current week only
  for (
    let day = new Date(weekStartUtc);
    day <= weekEnd;
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
  ) {
    for (const slot of sortedSlots) {
      let firstSlotTime: Date;

      if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
        // Only consider this slot if its configured weekday matches the current day (UTC-aware)
        const weeklySlot = slot as SlotOfAvailabilityWeekly;
        if (weeklySlot.dayOfWeekforStartTimeInUTC !== getUtcDayOfWeek(day))
          continue;

        // Construct candidate using UTC date + UTC hours/minutes from weekly availability
        const slotStartUtc = new Date(weeklySlot.slotStartTimeInUTC);
        firstSlotTime = new Date(
          Date.UTC(
            day.getUTCFullYear(),
            day.getUTCMonth(),
            day.getUTCDate(),
            slotStartUtc.getUTCHours(),
            slotStartUtc.getUTCMinutes(),
            0,
            0
          )
        );
      } else {
        // CUSTOM: use exact slot date but only within the current week window (UTC day match)
        const customSlot = slot as SlotOfAvailabilityCustom;
        const candidate = new Date(customSlot.slotStartTimeInUTC);
        if (getUtcDayKey(candidate) !== getUtcDayKey(day)) continue;
        firstSlotTime = candidate;
      }

      // Enforce 'from present' - no past slots and must be within this week
      if (firstSlotTime <= now) continue;
      if (firstSlotTime > weekEnd) continue;
      if (bookedSlots.has(firstSlotTime.toISOString())) continue;

      // FCFS: try to take the first block of consecutive 30-minute slots on this day
      const consecutiveSlots: Date[] = [];
      let currentSlotTime = new Date(firstSlotTime);
      let canAllocate = true;

      for (let i = 0; i < requiredSlots; i++) {
        const slotTime = new Date(currentSlotTime);

        // must stay within the same day
        if (getUtcDayKey(slotTime) !== getUtcDayKey(firstSlotTime)) {
          canAllocate = false;
          break;
        }

        // must not be booked
        if (bookedSlots.has(slotTime.toISOString())) {
          canAllocate = false;
          break;
        }

        // must be part of consultant's declared availability
        if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
          const dow = getUtcDayOfWeek(firstSlotTime);
          const minutes =
            slotTime.getUTCHours() * 60 + slotTime.getUTCMinutes();
          const ranges = weeklyRangesByDow.get(dow) || [];
          // Check that this slot and its 30-min window stay within at least one range
          const withinRange = ranges.some(
            (r) => minutes >= r.start && minutes + 30 <= r.end
          );
          if (!withinRange) {
            canAllocate = false;
            break;
          }
        } else {
          const dayKey = getUtcDayKey(slotTime);
          const ranges = customRangesByDay.get(dayKey) || [];
          const slotEnd = new Date(slotTime.getTime() + 30 * 60 * 1000);
          const withinRange = ranges.some(
            (r) =>
              slotTime.getTime() >= r.start.getTime() &&
              slotEnd.getTime() <= r.end.getTime()
          );
          if (!withinRange) {
            canAllocate = false;
            break;
          }
        }

        consecutiveSlots.push(slotTime);
        currentSlotTime = new Date(slotTime.getTime() + 30 * 60 * 1000);
      }

      if (canAllocate && consecutiveSlots.length === requiredSlots) {
        await validateConsultationSlots(consecutiveSlots, consultation, tx);
        return consecutiveSlots;
      }
    }
  }

  throw new Error(
    `Unable to find ${requiredSlots} consecutive available slots within the current week for this ${consultationPlan.durationInHours}-hour consultation. Try adding availability this week or select manually.`
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
    if (!body.clear) {
      if (typeof body.isAuto !== "boolean") {
        return NextResponse.json(
          { error: "isAuto flag is required" },
          { status: 400 }
        );
      }
    }

    if (body.clear) {
      // clearing slots does not require isAuto or slots
    } else if (body.useRequestedSlots) {
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

    // If already approved and neither reallocate nor clear is provided, block. Otherwise allow.
    if (
      consultation.requestStatus === RequestStatus.APPROVED &&
      !body.reallocate &&
      !body.clear
    ) {
      return NextResponse.json(
        {
          error:
            "Consultation is already approved. Pass reallocate=true to update slots.",
        },
        { status: 400 }
      );
    }

    try {
      // Use transaction to ensure atomic updates and prevent race conditions
      const result = await prisma.$transaction(
        async (tx) => {
          // Re-fetch consultation within transaction to ensure data consistency
          const currentConsultation = await tx.consultation.findUnique({
            where: { id: consultationId },
            include: consultationInclude,
          });

          if (!currentConsultation) {
            throw new Error("Consultation not found");
          }

          // Handle clear request first: delete existing appointment only
          if (body.clear) {
            if (currentConsultation.appointment) {
              await tx.appointment.delete({
                where: { id: currentConsultation.appointment.id },
              });
            }
            const updatedConsultation = await tx.consultation.findUnique({
              where: { id: consultationId },
              include: consultationInclude,
            });
            return {
              consultation: updatedConsultation,
              appointment: null,
            } as any;
          }

          // Check if consultation is already approved and has appointment
          if (
            currentConsultation.requestStatus === RequestStatus.APPROVED &&
            currentConsultation.appointment &&
            !body.reallocate &&
            !body.useRequestedSlots
          ) {
            // Return existing appointment instead of creating a new one
            return {
              consultation: currentConsultation,
              appointment: currentConsultation.appointment,
            };
          }

          // If using requested slots and appointment exists, just approve the consultation
          if (body.useRequestedSlots && currentConsultation.appointment) {
            const requestedSlots =
              currentConsultation.appointment.slotsOfAppointment;
            if (!requestedSlots || requestedSlots.length === 0) {
              throw new Error("No requested slots found");
            }

            const selectedSlots = requestedSlots.map(
              (slot) => new Date(slot.slotStartTimeInUTC)
            );

            // Use the comprehensive validation function
            await validateConsultationSlots(
              selectedSlots,
              currentConsultation,
              tx
            );

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
              appointment: currentConsultation.appointment,
            };
          }

          // For auto/manual allocation, delete existing appointment if any (supports reallocation)
          if (!body.useRequestedSlots && currentConsultation.appointment) {
            await tx.appointment.delete({
              where: { id: currentConsultation.appointment.id },
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

          // No allowed period window for consultations; comprehensive validation above suffices
          // Create appointment with multiple slots for consultations
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
        },
        {
          maxWait: 5000, // 5 seconds max wait
          timeout: 10000, // 10 seconds timeout
          isolationLevel: "Serializable", // Ensure serializable isolation
        }
      );

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
