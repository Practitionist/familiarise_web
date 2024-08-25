import prisma from "../lib/prisma";
import { faker } from "@faker-js/faker";
import {
  AppointmentsType,
  ConsultantProfile,
  ConsulteeProfile,
  DayOfWeek,
  RequestStatus,
  ScheduleType,
  PlanDuration,
  PlanEmailSupport,
  User,
  UserRole,
  ConsultationMode
} from "@prisma/client";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });

// Big data
const NUM_USERS = 100;
const NUM_CONSULTANTS = 40;
const NUM_CONSULTEES = 60;
const NUM_SLOTS_PER_CONSULTANT = 20;
const NUM_APPOINTMENTS = 200;
const NUM_NEWSLETTERS = 100;


// Small data
// const NUM_USERS = 10;
// const NUM_CONSULTANTS = 4;
// const NUM_CONSULTEES = 6;
// const NUM_SLOTS_PER_CONSULTANT = 5;
// const NUM_APPOINTMENTS = 20;
// const NUM_NEWSLETTERS = 10;

type UserWithProfiles = User & {
  consultantProfile?: ConsultantProfile | null;
  consulteeProfile?: ConsulteeProfile | null;
};

async function createUsers(): Promise<UserWithProfiles[]> {
  const users: UserWithProfiles[] = [];
  console.log(`Creating ${NUM_USERS} users...`);
  for (let i = 0; i < NUM_USERS; i++) {
    const userRole = i < NUM_CONSULTANTS ? "CONSULTANT" : "CONSULTEE";
    try {
      const user = await prisma.user.create({
        data: {
          name: faker.person.fullName(),
          email: faker.internet.email(),
          emailVerified: faker.date.past(),
          image: faker.image.avatar(),
          phone: faker.phone.number(),
          address: faker.location.streetAddress(),
          onboardingCompleted: faker.datatype.boolean(),
          role: userRole as UserRole,
          cookiePreferences: {
            create: {
              essential: true,
              analytics: faker.datatype.boolean(),
              marketing: faker.datatype.boolean(),
            },
          },
          notificationPreferences: {
            create: {
              allNotifications: faker.datatype.boolean(),
              mentions: faker.datatype.boolean(),
              directMessages: faker.datatype.boolean(),
              updates: faker.datatype.boolean(),
            },
          },
          ...(userRole === "CONSULTANT" && {
            consultantProfile: {
              create: {
                rating: faker.number.float({ min: 1, max: 5, multipleOf: 0.1 }),
                onlineStatus: faker.datatype.boolean(),
                specialization: faker.person.jobArea(),
                experience: faker.helpers.arrayElement([
                  "1-3 years",
                  "3-5 years",
                  "5-10 years",
                  "10+ years",
                ]),
                location: faker.location.city(),
                description: faker.lorem.paragraph(),
                tags: faker.helpers.arrayElements(
                  ["Expert", "Certified", "Top Rated", "Experienced"],
                  { min: 1, max: 3 }
                ),
                domain: faker.person.jobType(),
                subDomains: faker.helpers.arrayElements(
                  [
                    "Risk Management",
                    "Training",
                    "Digital Marketing",
                    "Data Analysis",
                    "Supply Chain",
                  ],
                  { min: 1, max: 3 }
                ),
                currentTimezone: faker.location.timeZone(),
                scheduleType: faker.helpers.arrayElement([
                  "WEEKLY",
                  "CUSTOM",
                ]) as ScheduleType,
              },
            },
          }),
          ...(userRole === "CONSULTEE" && {
            consulteeProfile: {
              create: {
                location: faker.location.city(),
                onlineStatus: faker.datatype.boolean(),
                currentTimezone: faker.location.timeZone(),
                preferredConsultationMode: faker.helpers.arrayElement([
                  ConsultationMode.VIDEO,
                  ConsultationMode.AUDIO,
                  ConsultationMode.IN_PERSON,
                ]),
                preferredLanguage: faker.helpers.arrayElement(['English', 'Spanish', 'French', 'German', 'Chinese']),
                specialRequirements: faker.lorem.sentence(),
                domains: JSON.stringify(faker.helpers.arrayElements(
                  ['Technology', 'Finance', 'Healthcare', 'Education', 'Marketing'],
                  { min: 1, max: 3 }
                )),
              },
            },
          }),
        },
        include: {
          consultantProfile: true,
          consulteeProfile: true,
        },
      });
      users.push(user);
    } catch (error) {
      console.error("Failed to create user:", error);
    }
    if ((i + 1) % 10 === 0) {
      console.log(`Created ${i + 1} users`);
    }
  }
  console.log(`Created ${users.length} users successfully.`);
  return users;
}

async function createConsultationPlans(consultants: UserWithProfiles[]) {
  console.log(`Creating consultation plans for ${consultants.length} consultants...`);
  for (let i = 0; i < consultants.length; i++) {
    const consultant = consultants[i];
    if (!consultant.consultantProfile) {
      console.warn(`Skipping consultant ${consultant.id} - no profile found`);
      continue;
    }
    try {
      await prisma.consultationPlan.createMany({
        data: [
          {
            consultantProfileId: consultant.consultantProfile.id,
            duration: 0.5, // 30 minutes
            price: faker.number.int({ min: 2000, max: 5000 }), // $20 to $50
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            duration: 1, // 1 hour
            price: faker.number.int({ min: 4000, max: 10000 }), // $40 to $100
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            duration: 2, // 2 hours
            price: faker.number.int({ min: 7500, max: 20000 }), // $75 to $200
          },
        ],
      });
    } catch (error) {
      console.error(
        `Failed to create consultation plans for consultant ${consultant.id}:`,
        error
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created consultation plans for ${i + 1} consultants`);
    }
  }
}

async function createSubscriptionPlans(consultants: UserWithProfiles[]) {
  console.log(`Creating subscription plans for ${consultants.length} consultants...`);
  for (let i = 0; i < consultants.length; i++) {
    const consultant = consultants[i];
    if (!consultant.consultantProfile) {
      console.warn(`Skipping consultant ${consultant.id} - no profile found`);
      continue;
    }
    try {
      await prisma.subscriptionPlan.createMany({
        data: [
          {
            consultantProfileId: consultant.consultantProfile.id,
            duration: PlanDuration.ONE_MONTH,
            price: faker.number.int({ min: 9900, max: 19900 }), // $99 to $199
            callsPerWeek: 1,
            videoMeetings: 1,
            emailSupport: PlanEmailSupport.GENERAL,
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            duration: PlanDuration.THREE_MONTHS,
            price: faker.number.int({ min: 24900, max: 49900 }), // $249 to $499
            callsPerWeek: 2,
            videoMeetings: 2,
            emailSupport: PlanEmailSupport.PRIORITY,
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            duration: PlanDuration.SIX_MONTHS,
            price: faker.number.int({ min: 39900, max: 79900 }), // $399 to $799
            callsPerWeek: 3,
            videoMeetings: 4,
            emailSupport: PlanEmailSupport.DEDICATED,
          },
        ],
      });
    } catch (error) {
      console.error(
        `Failed to create subscription plans for consultant ${consultant.id}:`,
        error
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created subscription plans for ${i + 1} consultants`);
    }
  }
}

async function createWebinarPlans(consultants: UserWithProfiles[]) {
  console.log(`Creating webinar plans for ${consultants.length} consultants...`);
  for (let i = 0; i < consultants.length; i++) {
    const consultant = consultants[i];
    if (!consultant.consultantProfile) {
      console.warn(`Skipping consultant ${consultant.id} - no profile found`);
      continue;
    }
    try {
      await prisma.webinarPlan.createMany({
        data: [
          {
            consultantProfileId: consultant.consultantProfile.id,
            duration: 1, // 1 hour
            price: faker.number.int({ min: 1500, max: 3000 }), // $15 to $30
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            duration: 2, // 2 hours
            price: faker.number.int({ min: 2500, max: 5000 }), // $25 to $50
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            duration: 3, // 3 hours
            price: faker.number.int({ min: 3500, max: 7000 }), // $35 to $70
          },
        ],
      });
    } catch (error) {
      console.error(
        `Failed to create webinar plans for consultant ${consultant.id}:`,
        error
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created webinar plans for ${i + 1} consultants`);
    }
  }
}

async function createClassPlans(consultants: UserWithProfiles[]) {
  console.log(`Creating class plans for ${consultants.length} consultants...`);
  for (let i = 0; i < consultants.length; i++) {
    const consultant = consultants[i];
    if (!consultant.consultantProfile) {
      console.warn(`Skipping consultant ${consultant.id} - no profile found`);
      continue;
    }
    try {
      await prisma.classPlan.createMany({
        data: [
          {
            consultantProfileId: consultant.consultantProfile.id,
            duration: PlanDuration.ONE_MONTH,
            price: faker.number.int({ min: 19900, max: 39900 }), // $199 to $399
            callsPerWeek: 1,
            videoMeetings: 4,
            emailSupport: PlanEmailSupport.GENERAL,
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            duration: PlanDuration.THREE_MONTHS,
            price: faker.number.int({ min: 34900, max: 69900 }), // $349 to $699
            callsPerWeek: 2,
            videoMeetings: 8,
            emailSupport: PlanEmailSupport.PRIORITY,
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            duration: PlanDuration.SIX_MONTHS,
            price: faker.number.int({ min: 49900, max: 99900 }), // $499 to $999
            callsPerWeek: 3,
            videoMeetings: 12,
            emailSupport: PlanEmailSupport.DEDICATED,
          },
        ],
      });
    } catch (error) {
      console.error(
        `Failed to create class plans for consultant ${consultant.id}:`,
        error
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created class plans for ${i + 1} consultants`);
    }
  }
}

async function createSlotsOfAvailability(consultants: UserWithProfiles[]) {
  console.log(`Creating slots of availability for ${consultants.length} consultants...`);
  for (let i = 0; i < consultants.length; i++) {
    const consultant = consultants[i];
    if (!consultant.consultantProfile) {
      console.warn(`Skipping consultant ${consultant.id} - no profile found`);
      continue;
    }
    try {
      const slotType = consultant.consultantProfile.scheduleType;

      if (slotType === ScheduleType.WEEKLY) {
        // Create weekly slots
        for (let j = 0; j < NUM_SLOTS_PER_CONSULTANT; j++) {
          const dayOfWeek = faker.helpers.arrayElement(Object.values(DayOfWeek));
          const startHour = faker.helpers.arrayElement([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
          const durationHours = faker.helpers.arrayElement([0.5, 1, 1.5, 2, 2.5, 3]);

          const startTime = new Date();
          startTime.setUTCHours(startHour, startHour % 1 === 0 ? 0 : 30, 0, 0);

          const endTime = new Date(startTime);
          endTime.setTime(startTime.getTime() + durationHours * 60 * 60 * 1000);

          let endDayOfWeek = dayOfWeek;
          if (endTime.getUTCHours() < startTime.getUTCHours()) {
            // If end time is on the next day, adjust the day of week
            const daysOfWeek = Object.values(DayOfWeek);
            const currentIndex = daysOfWeek.indexOf(dayOfWeek);
            endDayOfWeek = daysOfWeek[(currentIndex + 1) % 7];
          }

          await prisma.slotOfAvailabiltyWeekly.create({
            data: {
              consultantProfileId: consultant.consultantProfile.id,
              dayOfWeekforStartTimeInUTC: dayOfWeek,
              slotStartTimeInUTC: startTime,
              dayOfWeekforEndTimeInUTC: endDayOfWeek,
              slotEndTimeInUTC: endTime,
            },
          });
        }
      } else {
        // Create custom slots
        for (let j = 0; j < NUM_SLOTS_PER_CONSULTANT; j++) {
          const startDate = faker.date.future();
          const startHour = faker.helpers.arrayElement([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
          const durationHours = faker.helpers.arrayElement([0.5, 1, 1.5, 2, 2.5, 3]);

          const startTime = new Date(startDate);
          startTime.setUTCHours(startHour, startHour % 1 === 0 ? 0 : 30, 0, 0);

          const endTime = new Date(startTime);
          endTime.setTime(startTime.getTime() + durationHours * 60 * 60 * 1000);

          if (endTime < startTime) {
            // If end time is on the next day, add one day to the end time
            endTime.setDate(endTime.getDate() + 1);
          }

          await prisma.slotOfAvailabiltyCustom.create({
            data: {
              consultantProfileId: consultant.consultantProfile.id,
              slotStartTimeInUTC: startTime,
              slotEndTimeInUTC: endTime,
            },
          });
        }
      }
    } catch (error) {
      console.error(
        `Failed to create slots of availability for consultant ${consultant.id}:`,
        error
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created slots of availability for ${i + 1} consultants`);
    }
  }
}

async function createAppointments(consultees: UserWithProfiles[]) {
  console.log(`Creating ${NUM_APPOINTMENTS} appointments...`);
  const weeklySlots = await prisma.slotOfAvailabiltyWeekly.findMany({
    take: NUM_APPOINTMENTS / 2,
  });
  const customSlots = await prisma.slotOfAvailabiltyCustom.findMany({
    take: NUM_APPOINTMENTS / 2,
  });
  const consultationPlans = await prisma.consultationPlan.findMany();
  const subscriptionPlans = await prisma.subscriptionPlan.findMany();
  const webinarPlans = await prisma.webinarPlan.findMany();
  const classPlans = await prisma.classPlan.findMany();

  const allSlots = [
    ...weeklySlots.map(slot => ({ type: 'weekly' as const, slot })),
    ...customSlots.map(slot => ({ type: 'custom' as const, slot }))
  ];

  for (let i = 0; i < NUM_APPOINTMENTS; i++) {
    const consultee = consultees[i % consultees.length];
    const slotData = allSlots[i];

    if (!consultee.consulteeProfile) {
      console.warn(`Skipping consultee ${consultee.id} - no profile found`);
      continue;
    }

    if (!slotData) {
      console.warn(`No slot data available for appointment ${i + 1}. This is likely due to insufficient slots created.Skipping appointment creation...`);
      continue;
    }

    try {
      const appointmentType = faker.helpers.arrayElement(
        Object.values(AppointmentsType)
      );

      let appointmentRequestData: any;

      if (slotData.type === 'weekly') {
        appointmentRequestData = {
          status: RequestStatus.PENDING,
          slotOfAvailabiltyWeekly: {
            connect: { id: slotData.slot.id }
          },
          slotOfAvailabiltyCustom: {
            create: {
              consultantProfileId: slotData.slot.consultantProfileId,
              slotStartTimeInUTC: slotData.slot.slotStartTimeInUTC,
              slotEndTimeInUTC: slotData.slot.slotEndTimeInUTC,
            }
          },
          appointmentStartTimeInUTC: slotData.slot.slotStartTimeInUTC,
          appointmentEndTimeInUTC: slotData.slot.slotEndTimeInUTC,
        };
      } else {
        appointmentRequestData = {
          status: RequestStatus.PENDING,
          slotOfAvailabiltyCustom: {
            connect: { id: slotData.slot.id }
          },
          slotOfAvailabiltyWeekly: {
            create: {
              consultantProfileId: slotData.slot.consultantProfileId,
              dayOfWeekforStartTimeInUTC: faker.helpers.arrayElement(Object.values(DayOfWeek)),
              slotStartTimeInUTC: slotData.slot.slotStartTimeInUTC,
              dayOfWeekforEndTimeInUTC: faker.helpers.arrayElement(Object.values(DayOfWeek)),
              slotEndTimeInUTC: slotData.slot.slotEndTimeInUTC,
            }
          },
          appointmentStartTimeInUTC: slotData.slot.slotStartTimeInUTC,
          appointmentEndTimeInUTC: slotData.slot.slotEndTimeInUTC,
        };
      }

      const appointmentRequest = await prisma.slotOfAppointmentRequest.create({
        data: appointmentRequestData,
      });

      const appointment = await prisma.slotOfAppointment.create({
        data: {
          consulteeProfileId: consultee.consulteeProfile.id,
          slotOfAppointmentRequestId: appointmentRequest.id,
          appointmentsType: appointmentType,
        },
      });

      switch (appointmentType) {
        case AppointmentsType.CONSULTATION:
          await prisma.consultation.create({
            data: {
              consultationPlanId:
                faker.helpers.arrayElement(consultationPlans).id,
              slotOfAppointment: { connect: { id: appointment.id } },
            },
          });
          break;
        case AppointmentsType.SUBSCRIPTION:
          await prisma.subscription.create({
            data: {
              planId: faker.helpers.arrayElement(subscriptionPlans).id,
              startDate: faker.date.recent(),
              endDate: faker.date.future(),
              slotOfAppointment: { connect: { id: appointment.id } },
            },
          });
          break;
        case AppointmentsType.WEBINAR:
          await prisma.webinar.create({
            data: {
              webinarPlanId: faker.helpers.arrayElement(webinarPlans).id,
              title: faker.lorem.sentence(),
              description: faker.lorem.paragraph(),
              scheduledAt: faker.date.future(),
              durationInHours: faker.number.float({
                min: 1,
                max: 3,
                multipleOf: 0.5,
              }),
              slotOfAppointment: { connect: { id: appointment.id } },
            },
          });
          break;
        case AppointmentsType.CLASS:
          await prisma.class.create({
            data: {
              classPlanId: faker.helpers.arrayElement(classPlans).id,
              title: faker.lorem.sentence(),
              description: faker.lorem.paragraph(),
              startDate: faker.date.recent(),
              endDate: faker.date.future(),
              slotOfAppointment: { connect: { id: appointment.id } },
            },
          });
          break;
      }
    } catch (error) {
      console.error(
        `Failed to create appointment for consultee ${consultee.id}:`,
        error
      );
    }
    if ((i + 1) % 20 === 0 || i === NUM_APPOINTMENTS - 1) {
      console.log(`Created ${i + 1} appointments`);
    }
  }
}

async function createNewsletters() {
  console.log(`Creating ${NUM_NEWSLETTERS} newsletter subscriptions...`);
  for (let i = 0; i < NUM_NEWSLETTERS; i++) {
    try {
      await prisma.newsletter.create({
        data: {
          email: faker.internet.email(),
        },
      });
    } catch (error) {
      console.error("Failed to create newsletter subscription:", error);
    }
    if ((i + 1) % 20 === 0 || i === NUM_NEWSLETTERS - 1) {
      console.log(`Created ${i + 1} newsletter subscriptions`);
    }
  }
}

async function createConsultantReviews(consultants: UserWithProfiles[], consultees: UserWithProfiles[]) {
  console.log(`Creating consultant reviews...`);
  let totalReviews = 0;
  for (const consultant of consultants) {
    if (!consultant.consultantProfile) continue;

    const numReviews = faker.number.int({ min: 1, max: 5 });
    for (let i = 0; i < numReviews; i++) {
      const consultee = faker.helpers.arrayElement(consultees);
      if (!consultee.consulteeProfile) continue;

      try {
        await prisma.consultantReview.create({
          data: {
            rating: faker.number.float({ min: 1, max: 5, multipleOf: 0.1 }),
            reviewDescription: faker.lorem.paragraph(),
            consultantProfileId: consultant.consultantProfile.id,
            consulteeProfileId: consultee.consulteeProfile.id,
          },
        });
        totalReviews++;
      } catch (error) {
        console.error(`Failed to create review for consultant ${consultant.id}:`, error);
      }
    }
  }
  console.log(`Created ${totalReviews} consultant reviews`);
}

async function seed() {
  console.log("Starting seed process...");

  const users = await createUsers();
  const consultants = users.filter((user) => user.role === "CONSULTANT");
  const consultees = users.filter((user) => user.role === "CONSULTEE");

  await createConsultationPlans(consultants);
  await createSubscriptionPlans(consultants);
  await createWebinarPlans(consultants);
  await createClassPlans(consultants);
  await createSlotsOfAvailability(consultants);
  await createAppointments(consultees);
  await createNewsletters();
  await createConsultantReviews(consultants, consultees);

  console.log("Seed data inserted successfully.");
}

seed()
  .catch((e) => {
    console.error("Error in seed function:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });