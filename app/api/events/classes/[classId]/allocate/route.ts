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
import { addHours, addWeeks, addMonths } from "date-fns";
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

const classInclude = {
  classPlan: {
    include: {
      consultantProfile: {
        select: {
          user: true,
          scheduleType: true,
          slotsOfAvailabilityWeekly: true,
          slotsOfAvailabilityCustom: true,
        },
      },
      classContents: true,
    },
  },
  appointments: {
    include: {
      slotsOfAppointment: true,
    },
  },
} as const;

type ClassWithRelations = Prisma.ClassGetPayload<{
  include: typeof classInclude;
}>;

// Helper functions
// (deduplicated: definitions exist earlier in the file)

function startOfWeekSunday(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day; // Adjust to Sunday
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

// ---- Refactor helpers to reduce cognitive complexity of auto-allocation ----
function getSessionDurationInHours(
  classDetails: ClassWithRelations["classPlan"],
): number {
  // Use the sessionDurationInHours field directly from the class plan
  return classDetails.sessionDurationInHours || 1;
}

async function fetchBookedSlots(
  tx: PrismaTransaction,
  consultantUserId: string,
): Promise<Set<string>> {
  const apps = await tx.appointment.findMany({
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
              user: {
                some: {
                  id: consultantUserId,
                },
              },
            },
          },
        },
      ],
    },
    include: { slotsOfAppointment: true },
  });

  return new Set(
    apps.flatMap((a) =>
      a.slotsOfAppointment.map((s: { slotStartTimeInUTC: Date }) =>
        s.slotStartTimeInUTC.toISOString(),
      ),
    ),
  );
}

function buildSessionStartTime(
  scheduleType: ScheduleType,
  day: Date,
  slot: SlotOfAvailabilityWeekly | SlotOfAvailabilityCustom,
): Date | null {
  const dt = new Date(day);
  if (scheduleType === ScheduleType.WEEKLY) {
    const weekly = slot as SlotOfAvailabilityWeekly;
    if (getDayOfWeek(day) !== weekly.dayOfWeekforStartTimeInUTC) return null;
    dt.setHours(
      weekly.slotStartTimeInUTC.getHours(),
      weekly.slotStartTimeInUTC.getMinutes(),
      0,
      0,
    );
    return dt;
  }
  const custom = slot as SlotOfAvailabilityCustom;
  if (!isSameDay(custom.slotStartTimeInUTC, day)) return null;
  dt.setTime(custom.slotStartTimeInUTC.getTime());
  return dt;
}

function canPlaceSessionChain(
  start: Date,
  slotsPerSession: number,
  booked: Set<string>,
): { ok: boolean; chain?: Date[] } {
  const chain: Date[] = [];
  for (let i = 0; i < slotsPerSession; i++) {
    const t = new Date(start.getTime() + i * 30 * 60 * 1000);
    if (t.toDateString() !== start.toDateString()) return { ok: false };
    if (booked.has(t.toISOString())) return { ok: false };
    chain.push(t);
  }
  return { ok: true, chain };
}

function selectWeekSlots(
  weekStart: Date,
  slotsPerSession: number,
  maxCallsThisWeek: number,
  scheduleType: ScheduleType,
  sortedSlots: Array<SlotOfAvailabilityWeekly | SlotOfAvailabilityCustom>,
  classStart: Date,
  classEnd: Date,
  now: Date,
  booked: Set<string>,
): Date[] {
  const picked: Date[] = [];
  for (
    let dayOffset = 0;
    dayOffset < 7 && picked.length < maxCallsThisWeek;
    dayOffset++
  ) {
    const day = new Date(weekStart);
    day.setDate(day.getDate() + dayOffset);
    if (day > classEnd) break;

    for (const slot of sortedSlots) {
      const start = buildSessionStartTime(scheduleType, day, slot);
      if (!start) continue;
      if (start < classStart || start > classEnd || start < now) continue;

      const chainCheck = canPlaceSessionChain(start, slotsPerSession, booked);
      if (!chainCheck.ok) continue;

      picked.push(start);
      chainCheck.chain!.forEach((t) => booked.add(t.toISOString()));
      break; // move to next day once one session is placed
    }
  }
  return picked;
}

async function allocateSlotsAuto(
  classPlan: ClassWithRelations,
  tx: PrismaTransaction,
): Promise<Date[]> {
  const { classPlan: details } = classPlan;
  const { consultantProfile } = details;
  if (!consultantProfile) throw new Error("Consultant profile not found");

  const baseSlots =
    consultantProfile.scheduleType === ScheduleType.WEEKLY
      ? consultantProfile.slotsOfAvailabilityWeekly
      : consultantProfile.slotsOfAvailabilityCustom;
  if (!baseSlots.length)
    throw new Error("No available slots found for consultant");

  const sortedSlots = [...baseSlots].sort(
    (a: any, b: any) =>
      new Date(a.slotStartTimeInUTC).getHours() -
      new Date(b.slotStartTimeInUTC).getHours(),
  );

  const booked = await fetchBookedSlots(tx, consultantProfile.user.id);
  const sessionHours = getSessionDurationInHours(details);
  const slotsPerSession = Math.ceil(sessionHours / 0.5); // 30-min slots

  const classStart = new Date();
  const classEnd = addMonths(classStart, details.durationInMonths);
  const { countSundayWeeksInclusive } = await import(
    "@/app/dashboard/consultant/[consultantId]/(features)/shared/utils/calendarUtils"
  );
  const totalWeeks = countSundayWeeksInclusive(classStart, classEnd);
  const totalRequiredCalls = totalWeeks * details.callsPerWeek;

  const selected: Date[] = [];
  const now = new Date();
  let weekStart = startOfWeekSunday(classStart);

  for (let w = 0; w < totalWeeks && selected.length < totalRequiredCalls; w++) {
    const picked = selectWeekSlots(
      weekStart,
      slotsPerSession,
      details.callsPerWeek,
      consultantProfile.scheduleType,
      sortedSlots as any,
      classStart,
      classEnd,
      now,
      booked,
    );
    selected.push(...picked);
    weekStart.setDate(weekStart.getDate() + 7);
  }

  if (selected.length < totalRequiredCalls) {
    throw new Error(
      `Required ${totalRequiredCalls} classes but could only find ${selected.length} available slots within the class period`,
    );
  }

  return selected.sort((a, b) => a.getTime() - b.getTime());
}

async function allocateSlotsRequested(
  classPlan: ClassWithRelations,
  tx: PrismaTransaction,
): Promise<Date[]> {
  // Get the requested slots from appointments
  const requestedSlots = classPlan.appointments?.flatMap(
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
            { webinar: { status: "SCHEDULED" } },
            { class: { status: "SCHEDULED" } },
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
  classPlan: ClassWithRelations,
  slots: string[],
  tx: PrismaTransaction,
): Promise<Date[]> {
  const { classPlan: classDetails } = classPlan;
  const { consultantProfile } = classDetails;

  if (!consultantProfile) {
    throw new Error("Consultant profile not found");
  }

  // Calculate session size based on class contents
  // FIXED: Use actual duration instead of hardcoded weeks calculation
  const totalCalls = classDetails.durationInMonths * classDetails.callsPerWeek;

  // Get session duration from class plan (not from class contents)
  const sessionDurationInHours = classDetails.sessionDurationInHours || 1;

  const slotsPerSession = Math.ceil(sessionDurationInHours / 0.5); // 30-min slots
  // PARTIAL ALLOCATION: Allow allocating any number of complete sessions

  // Convert string dates to Date objects for validation
  const slotDates = slots.map((slot) => new Date(slot));

  // Validate selection consists of complete sessions only
  if (slotDates.length % slotsPerSession !== 0) {
    throw new Error(
      `Selection must be in complete sessions of ${slotsPerSession} slot(s) each`,
    );
  }

  // Validate per-day consecutiveness and session grouping (allow adjacent sessions)
  const slotsByDay = new Map<string, Date[]>();
  for (const d of slotDates) {
    const key = d.toDateString();
    if (!slotsByDay.has(key)) slotsByDay.set(key, []);
    slotsByDay.get(key)!.push(d);
  }

  for (const [dayKey, daySlots] of Array.from(slotsByDay.entries())) {
    const sorted = [...daySlots].sort((a, b) => a.getTime() - b.getTime());

    // Ensure all slots in a day are consecutive
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (curr.getTime() !== prev.getTime() + 30 * 60 * 1000) {
        throw new Error(
          `Slots on ${new Date(dayKey).toLocaleDateString()} must be consecutive`,
        );
      }
    }

    // Ensure day slots form whole number of sessions
    if (sorted.length % slotsPerSession !== 0) {
      throw new Error(
        `Incomplete session on ${new Date(dayKey).toLocaleDateString()}. Need ${slotsPerSession - (sorted.length % slotsPerSession)} more slot(s).`,
      );
    }

    // Enforce max sessions per day (2)
    const sessionsToday = Math.floor(sorted.length / slotsPerSession);
    if (sessionsToday > 2) {
      throw new Error(
        `Maximum 2 sessions per day allowed (found ${sessionsToday} on ${new Date(dayKey).toLocaleDateString()})`,
      );
    }
  }

  // Validate all slots are in the future
  const now = new Date();
  for (const slotDate of slotDates) {
    if (slotDate <= now) {
      throw new Error("Cannot allocate slots in the past");
    }
  }

  // Validate slots match consultant's schedule type
  if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
    // UTC-aware range-based check: allow any 30-min interval within weekly availability windows
    const dayEnumByUtcIndex: DayOfWeek[] = [
      DayOfWeek.SUNDAY,
      DayOfWeek.MONDAY,
      DayOfWeek.TUESDAY,
      DayOfWeek.WEDNESDAY,
      DayOfWeek.THURSDAY,
      DayOfWeek.FRIDAY,
      DayOfWeek.SATURDAY,
    ];

    const rangesByDow = new Map<
      DayOfWeek,
      Array<{ start: number; end: number }>
    >();
    consultantProfile.slotsOfAvailabilityWeekly.forEach((ws: any) => {
      const start = new Date(ws.slotStartTimeInUTC);
      const end = new Date(ws.slotEndTimeInUTC);
      const startMinutes = start.getUTCHours() * 60 + start.getUTCMinutes();
      const endMinutes = end.getUTCHours() * 60 + end.getUTCMinutes();
      const dow: DayOfWeek = ws.dayOfWeekforStartTimeInUTC;
      const arr = rangesByDow.get(dow) || [];
      arr.push({ start: startMinutes, end: endMinutes });
      rangesByDow.set(dow, arr);
    });

    for (const slotDate of slotDates) {
      const dow = dayEnumByUtcIndex[slotDate.getUTCDay()];
      const startMinutes =
        slotDate.getUTCHours() * 60 + slotDate.getUTCMinutes();
      const endMinutes = startMinutes + 30; // 30-min slot window
      const ranges = rangesByDow.get(dow) || [];
      const withinAnyRange = ranges.some(
        (r) => startMinutes >= r.start && endMinutes <= r.end,
      );
      if (!withinAnyRange) {
        throw new Error(
          `Slot ${slotDate.toLocaleString()} does not match consultant's weekly schedule`,
        );
      }
    }
  } else {
    // For custom schedule, validate slots exist in custom slots
    const availableCustomSlots = new Set(
      consultantProfile.slotsOfAvailabilityCustom.map((slot) =>
        new Date(slot.slotStartTimeInUTC).toISOString(),
      ),
    );

    for (const slotDate of slotDates) {
      if (!availableCustomSlots.has(slotDate.toISOString())) {
        throw new Error(
          `Slot ${slotDate.toLocaleString()} is not in consultant's custom schedule`,
        );
      }
    }
  }

  // Check for conflicts with existing appointments
  const excludeThisClassAppointmentIds = (classPlan.appointments || []).map(
    (a) => a.id,
  );

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
              slotStartTimeInUTC: {
                in: slotDates,
              },
              user: {
                some: {
                  id: consultantProfile.user.id,
                },
              },
            },
          },
        },
        // IMPORTANT: while reallocating this class, ignore its own existing appointments
        excludeThisClassAppointmentIds.length > 0
          ? {
              NOT: {
                id: { in: excludeThisClassAppointmentIds },
              },
            }
          : {},
      ],
    },
  });

  if (existingAppointments.length > 0) {
    throw new Error("Some selected slots are already booked");
  }

  // Validate slots per week quota - FIXED: Account for session slots
  const slotsByWeek = new Map<string, number>();
  for (const slotDate of slotDates) {
    const weekStart = new Date(slotDate);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Get start of week
    const weekKey = weekStart.toISOString();
    slotsByWeek.set(weekKey, (slotsByWeek.get(weekKey) || 0) + 1);
  }

  // Convert slots back to sessions for validation
  const maxSlotsPerWeek = classDetails.callsPerWeek * slotsPerSession;
  for (const [week, count] of Array.from(slotsByWeek.entries())) {
    if (count > maxSlotsPerWeek) {
      throw new Error(
        `Too many slots allocated for week of ${new Date(week).toLocaleDateString()} (max ${maxSlotsPerWeek} slots for ${classDetails.callsPerWeek} sessions)`,
      );
    }
  }

  // Return sorted slots
  return slotDates.sort((a, b) => a.getTime() - b.getTime());
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  console.log(
    `⚠️ [CLASS ALLOCATION] Called - this should NOT happen during reschedule!`,
  );
  try {
    const { classId } = await params;
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

    // Fetch class with necessary relations
    const classPlan = await prisma.class.findUnique({
      where: { id: classId },
      include: classInclude,
    });

    if (!classPlan) {
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    }

    // Validate user information
    if (!classPlan.classPlan?.consultantProfile?.user?.id) {
      return NextResponse.json(
        { error: "Missing consultant information" },
        { status: 400 },
      );
    }

    const { consultantProfile } = classPlan.classPlan;
    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 400 },
      );
    }

    try {
      // Use transaction to ensure atomic updates
      const result = await prisma.$transaction(
        async (tx) => {
          // If using requested slots and appointments exist, just update status
          if (body.useRequestedSlots && classPlan.appointments?.length > 0) {
            // Validate all slots are still available
            const requestedSlots = classPlan.appointments.flatMap((appt) =>
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
                      {
                        webinar: { status: "SCHEDULED" },
                      },
                      {
                        class: { status: "SCHEDULED" },
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

            // Validate requested slots fall within allowed class period if defined
            if (classPlan.startDate && classPlan.endDate) {
              const allowedStart = new Date(classPlan.startDate);
              const allowedEnd = new Date(classPlan.endDate);
              for (const d of requestedSlots) {
                const dt = new Date(d);
                if (dt < allowedStart || dt > allowedEnd) {
                  throw new Error(
                    `Selected slot ${dt.toLocaleString()} is outside class period (${allowedStart.toLocaleString()} - ${allowedEnd.toLocaleString()})`,
                  );
                }
              }
            }

            // Update class status - preserve existing startDate/endDate if they exist
            const classUpdateData: any = {
              status: "SCHEDULED",
            };

            // Only update dates if they don't already exist
            if (!classPlan.startDate || !classPlan.endDate) {
              classUpdateData.startDate = requestedSlots[0];
              classUpdateData.endDate = addWeeks(
                requestedSlots[0],
                classPlan.classPlan.durationInMonths * 4,
              );
              console.log(
                `📅 [CLASS ALLOCATION] Setting new class window: ${requestedSlots[0]} - ${classUpdateData.endDate}`,
              );
            } else {
              console.log(
                `📅 [CLASS ALLOCATION] Preserving existing class window: ${classPlan.startDate} - ${classPlan.endDate}`,
              );
            }

            const updatedClass = await tx.class.update({
              where: { id: classId },
              data: classUpdateData,
              include: classInclude,
            });

            return {
              class: updatedClass,
              appointments: classPlan.appointments,
            };
          }

          // For auto/manual allocation, delete existing appointments if any
          if (!body.useRequestedSlots && classPlan.appointments?.length > 0) {
            await Promise.all(
              classPlan.appointments.map((appointment) =>
                tx.appointment.delete({
                  where: { id: appointment.id },
                }),
              ),
            );
          }

          // Get slots based on allocation method
          let selectedSlots;
          if (body.useRequestedSlots) {
            selectedSlots = await allocateSlotsRequested(classPlan, tx);
          } else if (body.isAuto) {
            selectedSlots = await allocateSlotsAuto(classPlan, tx);
          } else {
            selectedSlots = await allocateSlotsManual(
              classPlan,
              body.slots!,
              tx,
            );
          }

          // Boundary guard: ensure all auto/requested selections lie within the class window if defined
          if (classPlan.startDate && classPlan.endDate) {
            const allowedStart = new Date(classPlan.startDate);
            const allowedEnd = new Date(classPlan.endDate);
            for (const d of selectedSlots as Date[]) {
              if (d < allowedStart || d > allowedEnd) {
                throw new Error(
                  `Selected slot ${d.toLocaleString()} is outside class period (${allowedStart.toLocaleString()} - ${allowedEnd.toLocaleString()})`,
                );
              }
            }
          }

          // Use consistent session duration from class plan for appointment length
          const sessionDurationInHours = getSessionDurationInHours(
            classPlan.classPlan,
          );
          const slotsPerSession = Math.ceil(sessionDurationInHours / 0.5);

          // Group selected 30‑min slots into session starts (one per session)
          const startsByDay = new Map<string, Date[]>();
          for (const dt of selectedSlots as Date[]) {
            const key = dt.toDateString();
            if (!startsByDay.has(key)) startsByDay.set(key, []);
            startsByDay.get(key)!.push(dt);
          }
          const sessionStartTimes: Date[] = [];
          for (const day of Array.from(startsByDay.keys())) {
            const arr = (startsByDay.get(day) || []).sort(
              (a, b) => a.getTime() - b.getTime(),
            );
            for (let i = 0; i < arr.length; i += slotsPerSession) {
              sessionStartTimes.push(arr[i]);
            }
          }

          // Create appointments for each session start
          const appointments = await Promise.all(
            sessionStartTimes.map((slotTime: Date) =>
              tx.appointment.create({
                data: {
                  appointmentType: AppointmentsType.CLASS,
                  class: {
                    connect: { id: classId },
                  },
                  slotsOfAppointment: {
                    create: {
                      slotStartTimeInUTC: slotTime,
                      slotEndTimeInUTC: addHours(
                        slotTime,
                        sessionDurationInHours || 1,
                      ),
                      isTentative: false,
                      user: {
                        connect: [
                          {
                            id: (() => {
                              if (
                                !classPlan.classPlan.consultantProfile?.user?.id
                              ) {
                                throw new Error(
                                  "Missing consultant user information",
                                );
                              }
                              return classPlan.classPlan.consultantProfile.user
                                .id;
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
              }),
            ),
          );

          // Update class status - preserve existing startDate/endDate if they exist
          const classUpdateData: any = {
            status: "SCHEDULED",
          };

          // Only update dates if they don't already exist
          if (!classPlan.startDate || !classPlan.endDate) {
            classUpdateData.startDate = sessionStartTimes[0];
            classUpdateData.endDate = addWeeks(
              sessionStartTimes[0],
              classPlan.classPlan.durationInMonths * 4,
            );
            console.log(
              `📅 [CLASS ALLOCATION] Setting new class window: ${sessionStartTimes[0]} - ${classUpdateData.endDate}`,
            );
          } else {
            console.log(
              `📅 [CLASS ALLOCATION] Preserving existing class window: ${classPlan.startDate} - ${classPlan.endDate}`,
            );
          }

          const updatedClass = await tx.class.update({
            where: { id: classId },
            data: classUpdateData,
            include: classInclude,
          });

          return {
            class: updatedClass,
            appointments,
          };
        },
        {
          timeout: 30000, // Increase timeout to 30 seconds for class allocations
        },
      );

      return NextResponse.json({ data: result });
    } catch (error) {
      if (error instanceof Error) {
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
      console.error("Error: ", error.stack);
    }
    return NextResponse.json(
      { error: "An error occurred during slot allocation" },
      { status: 500 },
    );
  }
}
