import { faker } from "@faker-js/faker";
import {
  AppointmentsType,
  RequestStatus,
  Platform,
  WebinarStatus,
  ClassStatus,
  SlotOfAvailabilityWeekly,
  SlotOfAvailabilityCustom,
} from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./createUsers";
import { TAppointmentCreateInput } from "@/types/appointment";

const NUM_APPOINTMENTS = 200;

type SlotData =
  | {
      type: "weekly";
      slot: SlotOfAvailabilityWeekly;
    }
  | {
      type: "custom";
      slot: SlotOfAvailabilityCustom;
    };

// Helper function remains the same
function generateTentativeSchedule(
  startDate: Date,
  numSessions: number,
): string {
  return JSON.stringify(
    Array.from({ length: numSessions }, (_, index) => {
      const appointmentDate = new Date(startDate);
      appointmentDate.setDate(appointmentDate.getDate() + index * 7);
      const startTime = new Date(appointmentDate);
      startTime.setHours(faker.number.int({ min: 9, max: 17 }), 0, 0, 0);
      const endTime = new Date(startTime);
      endTime.setHours(
        startTime.getHours() + faker.number.int({ min: 1, max: 3 }),
      );
      const timezone = "UTC";
      return {
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        timezone: timezone,
      };
    }),
  );
}

export async function createAppointments(consultees: UserWithProfiles[]) {
  console.log(`Creating ${NUM_APPOINTMENTS} appointments...`);
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

  for (let i = 0; i < NUM_APPOINTMENTS; i++) {
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
      const appointmentType = faker.helpers.arrayElement<AppointmentsType>(
        Object.values(AppointmentsType),
      );

      await prisma.$transaction(async (prisma) => {
        const { slotStartTimeInUTC, slotEndTimeInUTC } = slotData.slot;

        const appointmentData: TAppointmentCreateInput = {
          appointmentType: appointmentType,
          slotsOfAppointment: {
            create: {
              user: {
                connect: [{
                  id: consultee.id,
                }],
              },
              slotStartTimeInUTC,
              slotEndTimeInUTC,
            },
          },
        };

        const now = new Date();
        // Create more past appointments for reviews
        const startDate = new Date(
          now.getTime() +
            faker.number.int({ min: -30, max: 7 }) * 24 * 60 * 60 * 1000,
        );
        const endDate = new Date(
          startDate.getTime() +
            faker.number.int({ min: 30, max: 365 }) * 24 * 60 * 60 * 1000,
        );
        const tentativeStartDate = new Date(
          startDate.getTime() +
            faker.number.int({ min: 1, max: 14 }) * 24 * 60 * 60 * 1000,
        );

        // Increase probability of completed/approved appointments
        const isPastAppointment = startDate < now;
        const defaultStatus = isPastAppointment
          ? faker.helpers.arrayElement([
              RequestStatus.APPROVED,
              RequestStatus.APPROVED,
              RequestStatus.APPROVED,
              RequestStatus.REJECTED,
              RequestStatus.CANCELLED,
            ])
          : faker.helpers.arrayElement(Object.values(RequestStatus));

        let appointmentTypeData;

        switch (appointmentType) {
          case AppointmentsType.CONSULTATION:
            appointmentTypeData = {
              consultationPlan: {
                connect: {
                  id: faker.helpers.arrayElement(consultationPlans).id,
                },
              },
              requestedBy: { connect: { id: consultee.consulteeProfile!.id } },
              requestStatus: defaultStatus,
              preferredDateTime: slotStartTimeInUTC,
              requestedAt: new Date(),
              requestNotes: faker.lorem.sentence(),
              directlyBooked: faker.datatype.boolean(),
              feedbackFromConsultee: isPastAppointment
                ? faker.lorem.paragraph()
                : null,
              feedbackFromConsultant: isPastAppointment
                ? faker.lorem.paragraph()
                : null,
              rating: isPastAppointment
                ? faker.number.float({ min: 1, max: 5, multipleOf: 0.5 })
                : null,
            };
            appointmentData.consultation = { create: appointmentTypeData };
            break;

          case AppointmentsType.SUBSCRIPTION:
            appointmentTypeData = {
              subscriptionPlan: {
                connect: {
                  id: faker.helpers.arrayElement(subscriptionPlans).id,
                },
              },
              startDate: startDate,
              endDate: endDate,
              requestedBy: { connect: { id: consultee.consulteeProfile!.id } },
              requestStatus: defaultStatus,
              requestedAt: new Date(),
              tentativeStartDate: tentativeStartDate,
              tentativeSchedule: generateTentativeSchedule(
                tentativeStartDate,
                4,
              ),
              requestNotes: faker.lorem.sentence(),
              feedbackFromConsultee: isPastAppointment
                ? faker.lorem.paragraph()
                : null,
              feedbackFromConsultant: isPastAppointment
                ? faker.lorem.paragraph()
                : null,
              rating: isPastAppointment
                ? faker.number.float({ min: 1, max: 5, multipleOf: 0.5 })
                : null,
            };
            appointmentData.subscription = { create: appointmentTypeData };
            break;

          case AppointmentsType.WEBINAR:
            appointmentTypeData = {
              webinarPlan: {
                connect: { id: faker.helpers.arrayElement(webinarPlans).id },
              },
              scheduledAt: startDate,
              endAt: endDate,
              status: isPastAppointment
                ? WebinarStatus.COMPLETED
                : faker.helpers.arrayElement(Object.values(WebinarStatus)),
              feedbackSummary: isPastAppointment
                ? faker.lorem.paragraph()
                : null,
              waitlist: isPastAppointment
                ? undefined
                : {
                    create: Array.from(
                      { length: faker.number.int({ min: 0, max: 5 }) },
                      () => ({
                        user: {
                          connect: {
                            id: faker.helpers.arrayElement(consultees).id,
                          },
                        },
                      }),
                    ),
                  },
              meetingRoom: {
                create: {
                  platform: faker.helpers.arrayElement(Object.values(Platform)),
                  meetingUrl: faker.internet.url(),
                  meetingId: faker.string.alphanumeric(10),
                  passcode: faker.string.alphanumeric(6),
                  hostKeys: [
                    faker.string.alphanumeric(8),
                    faker.string.alphanumeric(8),
                  ],
                  recordings: isPastAppointment
                    ? {
                        create: Array.from(
                          { length: faker.number.int({ min: 1, max: 3 }) },
                          () => ({
                            title: faker.lorem.words(3),
                            recordingUrl: faker.internet.url(),
                            duration: faker.number.int({ min: 30, max: 180 }),
                            recordedAt: faker.date.past(),
                          }),
                        ),
                      }
                    : undefined,
                },
              },
            };
            appointmentData.webinar = { create: appointmentTypeData };
            break;

          case AppointmentsType.CLASS:
            appointmentTypeData = {
              classPlan: {
                connect: { id: faker.helpers.arrayElement(classPlans).id },
              },
              startDate: startDate,
              endDate: endDate,
              tentativeStartDate: tentativeStartDate,
              tentativeSchedule: generateTentativeSchedule(
                tentativeStartDate,
                4,
              ),
              status: isPastAppointment
                ? ClassStatus.COMPLETED
                : faker.helpers.arrayElement(Object.values(ClassStatus)),
              recordingUrls: Array.from(
                { length: faker.number.int({ min: 0, max: 5 }) },
                () => faker.internet.url(),
              ),
              feedbackSummary: isPastAppointment
                ? faker.lorem.paragraph()
                : null,
              waitlist: isPastAppointment
                ? undefined
                : {
                    create: Array.from(
                      { length: faker.number.int({ min: 0, max: 5 }) },
                      () => ({
                        user: {
                          connect: {
                            id: faker.helpers.arrayElement(consultees).id,
                          },
                        },
                      }),
                    ),
                  },
              meetingRoom: {
                create: {
                  platform: faker.helpers.arrayElement(Object.values(Platform)),
                  meetingUrl: faker.internet.url(),
                  meetingId: faker.string.alphanumeric(10),
                  passcode: faker.string.alphanumeric(6),
                  hostKeys: [
                    faker.string.alphanumeric(8),
                    faker.string.alphanumeric(8),
                  ],
                  recordings: isPastAppointment
                    ? {
                        create: Array.from(
                          { length: faker.number.int({ min: 1, max: 3 }) },
                          () => ({
                            title: faker.lorem.words(3),
                            recordingUrl: faker.internet.url(),
                            duration: faker.number.int({ min: 30, max: 180 }),
                            recordedAt: faker.date.past(),
                          }),
                        ),
                      }
                    : undefined,
                },
              },
            };
            appointmentData.class = { create: appointmentTypeData };
            break;
        }

        await prisma.appointment.create({
          data: appointmentData,
        });
      });
    } catch (error) {
      console.error(
        `Failed to create appointment for consultee ${consultee.id}. Error details:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    if ((i + 1) % 20 === 0 || i === NUM_APPOINTMENTS - 1) {
      console.log(`Created ${i + 1} appointments`);
    }
  }
}
