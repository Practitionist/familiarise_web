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
import { TAppointmentCreateInput } from "../../types/appointment";

const NUM_APPOINTMENTS = 200;

// Define more specific types for each appointment type
type ConsultationCreate = NonNullable<
  TAppointmentCreateInput["consultation"]
>["create"];
type SubscriptionCreate = NonNullable<
  TAppointmentCreateInput["subscription"]
>["create"];
type WebinarCreate = NonNullable<TAppointmentCreateInput["webinar"]>["create"];
type ClassCreate = NonNullable<TAppointmentCreateInput["class"]>["create"];

type SlotData =
  | {
      type: "weekly";
      slot: SlotOfAvailabilityWeekly;
    }
  | {
      type: "custom";
      slot: SlotOfAvailabilityCustom;
    };

// Helper function to generate tentative schedule
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
        const slotStartTime =
          slotData.type === "weekly"
            ? slotData.slot.slotStartTimeInUTC
            : slotData.slot.slotStartTimeInUTC;
        const slotEndTime =
          slotData.type === "weekly"
            ? slotData.slot.slotEndTimeInUTC
            : slotData.slot.slotEndTimeInUTC;

        const appointmentData: TAppointmentCreateInput = {
          appointmentType: appointmentType,
          slotOfAppointment: {
            create: {
              consulteeProfile: {
                connect: { id: consultee.consulteeProfile!.id },
              },
              slotStartTimeInUTC: slotStartTime,
              slotEndTimeInUTC: slotEndTime,
            },
          },
        };

        const now = new Date();
        const startDate = new Date(
          now.getTime() +
            faker.number.int({ min: -7, max: 7 }) * 24 * 60 * 60 * 1000,
        );
        const endDate = new Date(
          startDate.getTime() +
            faker.number.int({ min: 30, max: 365 }) * 24 * 60 * 60 * 1000,
        );
        const tentativeStartDate = new Date(
          startDate.getTime() +
            faker.number.int({ min: 1, max: 14 }) * 24 * 60 * 60 * 1000,
        );

        switch (appointmentType) {
          case AppointmentsType.CONSULTATION:
            const consultationData: ConsultationCreate = {
              consultationPlan: {
                connect: {
                  id: faker.helpers.arrayElement(consultationPlans).id,
                },
              },
              requestedBy: { connect: { id: consultee.consulteeProfile!.id } },
              requestStatus: faker.helpers.arrayElement(
                Object.values(RequestStatus),
              ),
              preferredDateTime: slotStartTime,
              requestedAt: new Date(),
              requestNotes: faker.lorem.sentence(),
              directlyBooked: faker.datatype.boolean(),
              feedbackFromConsultee: faker.datatype.boolean()
                ? faker.lorem.paragraph()
                : null,
              feedbackFromConsultant: faker.datatype.boolean()
                ? faker.lorem.paragraph()
                : null,
              rating: faker.datatype.boolean()
                ? faker.number.float({ min: 1, max: 5, multipleOf: 0.5 })
                : null,
            };
            appointmentData.consultation = { create: consultationData };
            break;

          case AppointmentsType.SUBSCRIPTION:
            const subscriptionData: SubscriptionCreate = {
              subscriptionPlan: {
                connect: {
                  id: faker.helpers.arrayElement(subscriptionPlans).id,
                },
              },
              startDate: startDate,
              endDate: endDate,
              requestedBy: { connect: { id: consultee.consulteeProfile!.id } },
              requestStatus: faker.helpers.arrayElement(
                Object.values(RequestStatus),
              ),
              requestedAt: new Date(),
              tentativeStartDate: tentativeStartDate,
              tentativeSchedule: generateTentativeSchedule(
                tentativeStartDate,
                4,
              ),
              requestNotes: faker.lorem.sentence(),
              feedbackFromConsultee: faker.datatype.boolean()
                ? faker.lorem.paragraph()
                : null,
              feedbackFromConsultant: faker.datatype.boolean()
                ? faker.lorem.paragraph()
                : null,
              rating: faker.datatype.boolean()
                ? faker.number.float({ min: 1, max: 5, multipleOf: 0.5 })
                : null,
            };
            appointmentData.subscription = { create: subscriptionData };
            break;

          case AppointmentsType.WEBINAR:
            const webinarData: WebinarCreate = {
              webinarPlan: {
                connect: { id: faker.helpers.arrayElement(webinarPlans).id },
              },
              scheduledAt: startDate,
              endAt: endDate,
              status: faker.helpers.arrayElement(Object.values(WebinarStatus)),
              feedbackSummary: faker.datatype.boolean()
                ? faker.lorem.paragraph()
                : null,
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
                  recordings: faker.datatype.boolean()
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
            appointmentData.webinar = { create: webinarData };
            break;

          case AppointmentsType.CLASS:
            const classData: ClassCreate = {
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
              status: faker.helpers.arrayElement(Object.values(ClassStatus)),
              currentParticipants: faker.number.int({ min: 0, max: 30 }),
              recordingUrls: Array.from(
                { length: faker.number.int({ min: 0, max: 5 }) },
                () => faker.internet.url(),
              ),
              feedbackSummary: faker.datatype.boolean()
                ? faker.lorem.paragraph()
                : null,
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
                  recordings: faker.datatype.boolean()
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
            appointmentData.class = { create: classData };
            break;
        }

        // Create appointment lock for some appointments
        if (faker.datatype.boolean()) {
          const lockExpiresAt = new Date();
          lockExpiresAt.setMinutes(
            lockExpiresAt.getMinutes() + faker.number.int({ min: 5, max: 30 }),
          );
          appointmentData.appointmentLock = {
            create: {
              lockedAt: new Date(),
              expiresAt: lockExpiresAt,
            },
          };
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
