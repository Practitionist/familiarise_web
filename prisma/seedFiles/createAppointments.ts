import { faker } from "@faker-js/faker";
import {
  AppointmentsType,
  ClassStatus,
  DayOfWeek,
  Platform,
  Prisma,
  RequestStatus,
  SlotOfAvailabilityCustom,
  SlotOfAvailabilityWeekly,
  WebinarStatus,
} from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./createUsers";

const NUM_APPOINTMENTS = 500;
const BATCH_SIZE = 10; // Process appointments in smaller batches

// Distribution helpers
const getAppointmentType = (index: number): AppointmentsType => {
  // More realistic distribution with more subscriptions for testing validation
  if (index < 100) return AppointmentsType.CONSULTATION;
  if (index < 300) return AppointmentsType.SUBSCRIPTION; // More subscriptions for testing
  if (index < 400) return AppointmentsType.WEBINAR;
  return AppointmentsType.CLASS;
};

const getAppointmentStatus = (
  index: number,
  isPastAppointment: boolean,
): RequestStatus => {
  const rand = Math.random();

  if (isPastAppointment) {
    return rand < 0.8 ? RequestStatus.APPROVED : RequestStatus.CANCELLED;
  }

  if (rand < 0.3) return RequestStatus.PENDING;
  if (rand < 0.7) return RequestStatus.APPROVED;
  if (rand < 0.9) return RequestStatus.EXPIRED;
  return RequestStatus.CANCELLED;
};

const getAppointmentDate = (
  now: Date,
): { startDate: Date; endDate: Date; isPastAppointment: boolean } => {
  const rand = Math.random();
  let startOffset: number;
  let endOffset: number;
  let isPastAppointment = false;

  if (rand < 0.2) {
    // Past appointments (20%)
    startOffset = faker.number.int({ min: -90, max: -1 });
    endOffset = faker.number.int({ min: startOffset + 1, max: 0 });
    isPastAppointment = true;
  } else if (rand < 0.8) {
    // Near future (60%)
    startOffset = faker.number.int({ min: 1, max: 30 });
    endOffset = faker.number.int({
      min: startOffset + 7,
      max: startOffset + 30,
    });
  } else {
    // Far future (20%)
    startOffset = faker.number.int({ min: 31, max: 90 });
    endOffset = faker.number.int({
      min: startOffset + 7,
      max: startOffset + 60,
    });
  }

  const startDate = new Date(now.getTime() + startOffset * 24 * 60 * 60 * 1000);
  const endDate = new Date(now.getTime() + endOffset * 24 * 60 * 60 * 1000);

  return { startDate, endDate, isPastAppointment };
};

const getNumSlots = (appointmentType: AppointmentsType): number => {
  switch (appointmentType) {
    case AppointmentsType.CONSULTATION:
      return 1;
    case AppointmentsType.SUBSCRIPTION:
      // Create realistic subscription slots based on plan types
      const planType = faker.helpers.arrayElement([
        "basic",
        "extended",
        "comprehensive",
      ]);
      switch (planType) {
        case "basic":
          return faker.number.int({ min: 4, max: 5 }); // 1 call/week for 1 month
        case "extended":
          return faker.number.int({ min: 48, max: 52 }); // 2 calls/week for 6 months
        case "comprehensive":
          return faker.number.int({ min: 72, max: 78 }); // 3 calls/week for 6 months
        default:
          return faker.number.int({ min: 4, max: 12 });
      }
    case AppointmentsType.WEBINAR:
      return 1;
    case AppointmentsType.CLASS:
      return faker.number.int({ min: 4, max: 8 });
  }
};

type SlotData =
  | {
      type: "weekly";
      slot: SlotOfAvailabilityWeekly;
    }
  | {
      type: "custom";
      slot: SlotOfAvailabilityCustom;
    };

// --- Helper function to create MeetingSession data ---
const createMeetingSessionData = (
  isPastAppointment: boolean,
): Prisma.MeetingSessionCreateNestedOneWithoutSlotOfAppointmentInput => {
  return {
    create: {
      streamCallId: faker.string.uuid(),
      platform: faker.helpers.arrayElement(Object.values(Platform)),
      passcode: faker.string.alphanumeric(6),
      hostKeys: [faker.string.alphanumeric(8), faker.string.alphanumeric(8)],
      recordings: isPastAppointment
        ? {
            create: Array.from(
              { length: faker.number.int({ min: 0, max: 2 }) }, // 0 to 2 recordings for past meetings
              () => ({
                title: faker.lorem.words(3),
                recordingUrl: faker.internet.url(),
                durationInMinutes: faker.number.int({ min: 30, max: 180 }),
                recordedAt: faker.date.past(),
              }),
            ),
          }
        : undefined,
    },
  };
};

// --- Updated Appointment Creation Functions ---

const createConsultationAppointment = (
  consultee: UserWithProfiles,
  consultationPlans: any[],
  defaultStatus: RequestStatus,
  isPastAppointment: boolean,
  slotStartTimeInUTC: Date,
  slotEndTimeInUTC: Date,
): Prisma.AppointmentCreateInput => {
  return {
    appointmentType: AppointmentsType.CONSULTATION,
    slotsOfAppointment: {
      create: {
        user: {
          connect: [{ id: consultee.id }],
        },
        startsAt: slotStartTimeInUTC,
        endsAt: slotEndTimeInUTC,
        isTentative: defaultStatus === RequestStatus.PENDING,
        meetingSession: createMeetingSessionData(isPastAppointment),
      },
    },
    consultation: {
      create: {
        consultationPlan: {
          connect: {
            id: faker.helpers.arrayElement(consultationPlans).id,
          },
        },
        requestedBy: { connect: { id: consultee.consulteeProfile!.id } },
        requestStatus: defaultStatus,
        requestedAt: new Date(),
        requestNotes: faker.lorem.sentence(),
        bookingSource: faker.helpers.arrayElement([
          "DIRECT_CHECKOUT",
          "REQUEST_SUBMITTED",
        ]),
        feedbackFromConsultee: isPastAppointment
          ? faker.lorem.paragraph()
          : null,
        feedbackFromConsultant: isPastAppointment
          ? faker.lorem.paragraph()
          : null,
        rating: isPastAppointment
          ? faker.number.float({ min: 1, max: 5, multipleOf: 0.5 })
          : null,
      },
    },
  };
};

const createSubscriptionAppointment = (
  consultee: UserWithProfiles,
  subscriptionPlans: any[],
  consultantWeeklySlots: any[], // Add consultant's weekly availability
  defaultStatus: RequestStatus,
  isPastAppointment: boolean,
  startDate: Date,
  endDate: Date,
  numSlots: number,
): Prisma.AppointmentCreateInput => {
  // Select a random subscription plan
  const selectedPlan = faker.helpers.arrayElement(subscriptionPlans);

  // Calculate realistic number of slots based on SUBSCRIPTION INSTANCE duration (not plan duration)
  const callsPerWeek = selectedPlan.callsPerWeek;
  const subscriptionDurationMs = endDate.getTime() - startDate.getTime();
  const subscriptionWeeks = Math.ceil(
    subscriptionDurationMs / (7 * 24 * 60 * 60 * 1000),
  );
  const maxTotalCalls = Math.min(callsPerWeek * subscriptionWeeks, numSlots);

  // Get consultant's available days of week from their weekly slots
  const availableDaysSet = new Set(
    consultantWeeklySlots.map((s) => s.dayOfWeekForStartsAt),
  );
  const availableDays = Array.from(availableDaysSet);

  if (availableDays.length === 0) {
    console.warn(
      "Consultant has no weekly availability slots. Creating minimal slots.",
    );
  }

  // Helper function to convert Date to DayOfWeek enum
  const getDayOfWeekEnum = (date: Date): DayOfWeek => {
    const dayMap: Record<number, DayOfWeek> = {
      0: DayOfWeek.SUNDAY,
      1: DayOfWeek.MONDAY,
      2: DayOfWeek.TUESDAY,
      3: DayOfWeek.WEDNESDAY,
      4: DayOfWeek.THURSDAY,
      5: DayOfWeek.FRIDAY,
      6: DayOfWeek.SATURDAY,
    };
    return dayMap[date.getUTCDay()];
  };

  // Create slots distributed across weeks, respecting consultant's availability
  const slots = [];
  const currentDate = new Date(startDate);
  let slotsCreated = 0;

  // Iterate through the subscription period
  while (currentDate < endDate && slotsCreated < maxTotalCalls) {
    const currentDayOfWeek = getDayOfWeekEnum(currentDate);

    // Only create slots on days consultant works
    if (availableDays.includes(currentDayOfWeek)) {
      // Find available time slots for this day
      const daySlotsForConsultant = consultantWeeklySlots.filter(
        (s) => s.dayOfWeekForStartsAt === currentDayOfWeek,
      );

      if (daySlotsForConsultant.length > 0) {
        // Pick a random time from consultant's availability
        const randomSlot = faker.helpers.arrayElement(daySlotsForConsultant);

        // Create appointment slot at this time
        const slotStart = new Date(currentDate);
        slotStart.setUTCHours(
          randomSlot.availabilityStartsAt.getUTCHours(),
          randomSlot.availabilityStartsAt.getUTCMinutes(),
          0,
          0,
        );

        const slotEnd = new Date(
          slotStart.getTime() +
            selectedPlan.sessionDurationInHours * 60 * 60 * 1000,
        );

        // Ensure slot is within subscription period
        if (slotStart >= startDate && slotEnd <= endDate) {
          slots.push({
            user: {
              connect: [{ id: consultee.id }],
            },
            startsAt: slotStart,
            endsAt: slotEnd,
            isTentative: defaultStatus === RequestStatus.PENDING,
            meetingSession: createMeetingSessionData(
              isPastAppointment && slotStart < new Date(),
            ),
          });
          slotsCreated++;
        }
      }
    }

    // Move to next day
    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
  }

  // If no slots were created (edge case), create at least one slot
  if (slots.length === 0 && consultantWeeklySlots.length > 0) {
    console.warn(
      "No slots created within subscription period. Creating one slot at start.",
    );
    const randomSlot = faker.helpers.arrayElement(consultantWeeklySlots);
    const slotStart = new Date(startDate);
    slotStart.setUTCHours(
      randomSlot.availabilityStartsAt.getUTCHours(),
      randomSlot.availabilityStartsAt.getUTCMinutes(),
      0,
      0,
    );
    const slotEnd = new Date(
      slotStart.getTime() +
        selectedPlan.sessionDurationInHours * 60 * 60 * 1000,
    );

    slots.push({
      user: {
        connect: [{ id: consultee.id }],
      },
      startsAt: slotStart,
      endsAt: slotEnd,
      isTentative: defaultStatus === RequestStatus.PENDING,
      meetingSession: createMeetingSessionData(isPastAppointment),
    });
  }

  return {
    appointmentType: AppointmentsType.SUBSCRIPTION,
    slotsOfAppointment: {
      create: slots,
    },
    subscription: {
      create: {
        subscriptionPlan: {
          connect: {
            id: selectedPlan.id,
          },
        },
        requestedBy: { connect: { id: consultee.consulteeProfile!.id } },
        requestStatus: defaultStatus,
        requestedAt: new Date(),
        requestNotes: faker.lorem.sentence(),
        bookingSource: faker.helpers.arrayElement([
          "DIRECT_CHECKOUT",
          "REQUEST_SUBMITTED",
        ]),
        schedulingPeriodStartsAt: startDate,
        schedulingPeriodEndsAt: endDate,
        schedulingTimezone: "UTC",
        feedbackFromConsultee: isPastAppointment
          ? faker.lorem.paragraph()
          : null,
        feedbackFromConsultant: isPastAppointment
          ? faker.lorem.paragraph()
          : null,
        rating: isPastAppointment
          ? faker.number.float({ min: 1, max: 5, multipleOf: 0.5 })
          : null,
      },
    },
  };
};

const createWebinarAppointment = async (
  consultee: UserWithProfiles,
  webinarPlans: any[],
  consultees: UserWithProfiles[],
  isPastAppointment: boolean,
  slotStartTimeInUTC: Date,
  slotEndTimeInUTC: Date,
): Promise<Prisma.AppointmentCreateInput> => {
  // Limit waitlist size to prevent transaction timeout
  const waitlistSize = Math.min(faker.number.int({ min: 0, max: 3 }), 3);

  return {
    appointmentType: AppointmentsType.WEBINAR,
    slotsOfAppointment: {
      create: {
        user: {
          connect: [{ id: consultee.id }],
        },
        startsAt: slotStartTimeInUTC,
        endsAt: slotEndTimeInUTC,
        isTentative: false,
        meetingSession: createMeetingSessionData(isPastAppointment),
      },
    },
    webinar: {
      create: {
        webinarPlan: {
          connect: { id: faker.helpers.arrayElement(webinarPlans).id },
        },
        status: isPastAppointment
          ? WebinarStatus.COMPLETED
          : faker.helpers.arrayElement(Object.values(WebinarStatus)),
        feedbackSummary: isPastAppointment ? faker.lorem.paragraph() : null,
        waitlist: isPastAppointment
          ? undefined
          : waitlistSize > 0
            ? {
                create: Array.from(
                  new Set(
                    Array.from(
                      { length: waitlistSize },
                      () => faker.helpers.arrayElement(consultees).id,
                    ),
                  ),
                ).map((userId) => ({
                  user: {
                    connect: { id: userId },
                  },
                })),
              }
            : undefined,
      },
    },
  };
};

const createClassAppointment = async (
  consultee: UserWithProfiles,
  classPlans: any[],
  consultees: UserWithProfiles[],
  isPastAppointment: boolean,
  startDate: Date,
  endDate: Date,
  numSlots: number,
): Promise<Prisma.AppointmentCreateInput> => {
  // Limit slots and waitlist to prevent transaction timeout
  const limitedSlots = Math.min(numSlots, 4);
  const waitlistSize = Math.min(faker.number.int({ min: 0, max: 3 }), 3);

  return {
    appointmentType: AppointmentsType.CLASS,
    slotsOfAppointment: {
      create: Array.from({ length: limitedSlots }, (_, index) => {
        const slotStart = new Date(
          startDate.getTime() + index * 7 * 24 * 60 * 60 * 1000,
        );

        // Set class sessions to business hours (9 AM - 6 PM) in UTC
        const businessHours = [9, 10, 11, 14, 15, 16, 17];
        const businessHour = faker.helpers.arrayElement(businessHours);
        slotStart.setUTCHours(businessHour, 0, 0, 0);

        const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);

        return {
          user: {
            connect: [{ id: consultee.id }],
          },
          startsAt: slotStart,
          endsAt: slotEnd,
          isTentative: false,
          meetingSession: createMeetingSessionData(
            isPastAppointment && index === limitedSlots - 1,
          ),
        };
      }),
    },
    class: {
      create: {
        classPlan: {
          connect: { id: faker.helpers.arrayElement(classPlans).id },
        },
        schedulingPeriodStartsAt: startDate,
        schedulingPeriodEndsAt: endDate,
        schedulingTimezone: "UTC",
        status: isPastAppointment
          ? ClassStatus.COMPLETED
          : faker.helpers.arrayElement(Object.values(ClassStatus)),
        recordingUrls: Array.from(
          { length: faker.number.int({ min: 0, max: 3 }) }, // Reduced from 5 to 3
          () => faker.internet.url(),
        ),
        feedbackSummary: isPastAppointment ? faker.lorem.paragraph() : null,
        waitlist: isPastAppointment
          ? undefined
          : waitlistSize > 0
            ? {
                create: Array.from(
                  new Set(
                    Array.from(
                      { length: waitlistSize },
                      () => faker.helpers.arrayElement(consultees).id,
                    ),
                  ),
                ).map((userId) => ({
                  user: {
                    connect: { id: userId },
                  },
                })),
              }
            : undefined,
      },
    },
  };
};

async function createAppointmentBatch(
  consultees: UserWithProfiles[],
  allSlots: SlotData[],
  consultationPlans: any[],
  subscriptionPlans: any[],
  webinarPlans: any[],
  classPlans: any[],
  weeklySlots: any[],
  startIndex: number,
  batchSize: number,
): Promise<number> {
  let successCount = 0;

  for (
    let i = startIndex;
    i < Math.min(startIndex + batchSize, NUM_APPOINTMENTS);
    i++
  ) {
    const consultee = consultees[i % consultees.length];
    const slotData = allSlots[i];

    if (!consultee.consulteeProfile) {
      console.warn(`Skipping consultee ${consultee.id} - no profile found`);
      continue;
    }

    if (!slotData) {
      console.warn(
        `No slot data available for appointment ${i + 1}. This is likely due to insufficient slots created. Skipping appointment creation...`,
      );
      continue;
    }

    try {
      const appointmentType = getAppointmentType(i);
      const now = new Date();
      const { startDate, endDate, isPastAppointment } = getAppointmentDate(now);
      const defaultStatus = getAppointmentStatus(i, isPastAppointment);
      const numSlots = getNumSlots(appointmentType);

      // Extract the consultant ID from the slot to ensure data integrity
      // This ensures appointments use the correct consultant's plans
      const slotConsultantId = slotData.slot.consultantProfileId;

      // Filter plans to only include those belonging to the slot's consultant
      // This prevents appointments from being linked to the wrong consultant's plans
      const consultantConsultationPlans = consultationPlans.filter(
        (p) => p.consultantProfileId === slotConsultantId,
      );
      const consultantSubscriptionPlans = subscriptionPlans.filter(
        (p) => p.consultantProfileId === slotConsultantId,
      );
      const consultantWebinarPlans = webinarPlans.filter(
        (p) => p.consultantProfileId === slotConsultantId,
      );
      const consultantClassPlans = classPlans.filter(
        (p) => p.consultantProfileId === slotConsultantId,
      );

      // Filter weekly slots for this consultant (needed for subscription appointments)
      const consultantWeeklySlots = weeklySlots.filter(
        (s) => s.consultantProfileId === slotConsultantId,
      );

      // Skip if consultant has no plans for this appointment type
      if (
        appointmentType === AppointmentsType.CONSULTATION &&
        consultantConsultationPlans.length === 0
      ) {
        continue;
      }
      if (
        appointmentType === AppointmentsType.SUBSCRIPTION &&
        consultantSubscriptionPlans.length === 0
      ) {
        continue;
      }
      if (
        appointmentType === AppointmentsType.WEBINAR &&
        consultantWebinarPlans.length === 0
      ) {
        continue;
      }
      if (
        appointmentType === AppointmentsType.CLASS &&
        consultantClassPlans.length === 0
      ) {
        continue;
      }

      // Extract just the time pattern (hours and minutes) from the slot
      const slotTime = slotData.slot;
      const startHours = slotTime.availabilityStartsAt.getUTCHours();
      const startMinutes = slotTime.availabilityStartsAt.getUTCMinutes();
      const endHours = slotTime.availabilityEndsAt.getUTCHours();
      const endMinutes = slotTime.availabilityEndsAt.getUTCMinutes();

      // Create new dates using the appointment's actual date
      const actualStartTime = new Date(startDate);
      actualStartTime.setUTCHours(startHours, startMinutes, 0, 0);

      const actualEndTime = new Date(startDate);
      actualEndTime.setUTCHours(endHours, endMinutes, 0, 0);

      // Check if this is an overnight slot (end hour < start hour OR same hour but end minute < start minute)
      if (
        endHours < startHours ||
        (endHours === startHours && endMinutes < startMinutes)
      ) {
        actualEndTime.setDate(actualEndTime.getDate() + 1);
      }

      // Prepare appointment data outside transaction
      let appointmentData: Prisma.AppointmentCreateInput;

      switch (appointmentType) {
        case AppointmentsType.CONSULTATION:
          appointmentData = createConsultationAppointment(
            consultee,
            consultantConsultationPlans,
            defaultStatus,
            isPastAppointment,
            actualStartTime,
            actualEndTime,
          );
          break;

        case AppointmentsType.SUBSCRIPTION:
          appointmentData = createSubscriptionAppointment(
            consultee,
            consultantSubscriptionPlans,
            consultantWeeklySlots,
            defaultStatus,
            isPastAppointment,
            startDate,
            endDate,
            numSlots,
          );
          break;

        case AppointmentsType.WEBINAR:
          appointmentData = await createWebinarAppointment(
            consultee,
            consultantWebinarPlans,
            consultees,
            isPastAppointment,
            actualStartTime,
            actualEndTime,
          );
          break;

        case AppointmentsType.CLASS:
          appointmentData = await createClassAppointment(
            consultee,
            consultantClassPlans,
            consultees,
            isPastAppointment,
            startDate,
            endDate,
            numSlots,
          );
          break;
      }

      // Execute transaction with increased timeout (60 seconds)
      await prisma.$transaction(
        async (tx) => {
          await tx.appointment.create({
            data: appointmentData,
          });
        },
        {
          timeout: 60000, // Increased to 60 seconds
        },
      );

      successCount++;
    } catch (error) {
      console.error(
        `Failed to create appointment ${i + 1} for consultee ${consultee.id}. Error details:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return successCount;
}

export async function createAppointments(consultees: UserWithProfiles[]) {
  console.log(
    `Creating ${NUM_APPOINTMENTS} appointments in batches of ${BATCH_SIZE}...`,
  );

  // Fetch all required data upfront
  const weeklySlots = await prisma.slotOfAvailabilityWeekly.findMany({
    take: NUM_APPOINTMENTS / 2,
  });
  const customSlots = await prisma.slotOfAvailabilityCustom.findMany({
    take: NUM_APPOINTMENTS / 2,
  });
  const consultationPlans = await prisma.consultationPlan.findMany();
  const subscriptionPlans = await prisma.subscriptionPlan.findMany();
  const webinarPlans = await prisma.webinarPlan.findMany();
  const classPlans = await prisma.classPlan.findMany();

  const allSlots: SlotData[] = [
    ...weeklySlots.map((slot) => ({ type: "weekly" as const, slot })),
    ...customSlots.map((slot) => ({ type: "custom" as const, slot })),
  ];

  let totalCreated = 0;

  // Process appointments in batches
  for (
    let batchStart = 0;
    batchStart < NUM_APPOINTMENTS;
    batchStart += BATCH_SIZE
  ) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, NUM_APPOINTMENTS);
    console.log(`Processing appointments ${batchStart + 1} to ${batchEnd}...`);

    const batchCount = await createAppointmentBatch(
      consultees,
      allSlots,
      consultationPlans,
      subscriptionPlans,
      webinarPlans,
      classPlans,
      weeklySlots,
      batchStart,
      BATCH_SIZE,
    );

    totalCreated += batchCount;

    if (batchEnd % 20 === 0 || batchEnd === NUM_APPOINTMENTS) {
      console.log(
        `Created ${totalCreated} appointments successfully (processed ${batchEnd} total)`,
      );
    }

    // Small delay between batches to prevent overwhelming the database
    if (batchEnd < NUM_APPOINTMENTS) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  console.log(
    `Finished creating appointments. Successfully created ${totalCreated} out of ${NUM_APPOINTMENTS} requested.`,
  );
}
