import { faker } from "@faker-js/faker";
import {
  AppointmentsType,
  ClassEmailSupport,
  DayOfWeek,
  RequestStatus,
  ScheduleType,
  SlotType,
  SubscriptionEmailSupport,
  SubscriptionPlanDuration,
  UserRole,
} from "@prisma/client";
import * as dotenv from "dotenv";
import prisma from "../lib/prisma";
dotenv.config({ path: ".env" });

async function createUsers() {
  for (let i = 0; i < 40; i++) {
    const userRole = faker.helpers.arrayElement([
      "CONSULTANT",
      "CONSULTEE",
      "ADMIN",
      "STAFF",
    ]);
    console.log(`Creating user with role: ${userRole}`);
    try {
      await prisma.user.create({
        data: {
          name: faker.person.fullName(),
          email: faker.internet.email(),
          emailVerified: faker.date.past(),
          image: faker.image.avatar(),
          phone: faker.phone.number(),
          address: faker.location.streetAddress(),
          onboardingCompleted: faker.datatype.boolean(),
          role: userRole as UserRole,
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
              },
            },
          }),
        },
      });
    } catch (error) {
      console.error("Failed to create user:", error);
    }
  }
}

async function createConsultationPlans() {
  const consultants = await prisma.consultantProfile.findMany();

  for (const consultant of consultants) {
    try {
      console.log(
        `Creating consultation plans for consultant: ${consultant.id}`
      );
      await prisma.consultationPlan.createMany({
        data: [
          {
            consultantId: consultant.id,
            duration: 0.5, // 30 minutes
            price: faker.number.int({ min: 2000, max: 5000 }), // $20 to $50
          },
          {
            consultantId: consultant.id,
            duration: 1, // 1 hour
            price: faker.number.int({ min: 4000, max: 10000 }), // $40 to $100
          },
          {
            consultantId: consultant.id,
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
  }
}

async function createSubscriptionPlans() {
  const consultants = await prisma.consultantProfile.findMany();

  for (const consultant of consultants) {
    try {
      console.log(
        `Creating subscription plans for consultant: ${consultant.id}`
      );
      await prisma.subscriptionPlan.createMany({
        data: [
          {
            consultantProfileId: consultant.id,
            duration: SubscriptionPlanDuration.ONE_MONTH,
            price: faker.number.int({ min: 9900, max: 19900 }), // $99 to $199
            callsPerWeek: 1,
            videoMeetings: 1,
            emailSupport: SubscriptionEmailSupport.GENERAL,
          },
          {
            consultantProfileId: consultant.id,
            duration: SubscriptionPlanDuration.THREE_MONTHS,
            price: faker.number.int({ min: 24900, max: 49900 }), // $249 to $499
            callsPerWeek: 2,
            videoMeetings: 2,
            emailSupport: SubscriptionEmailSupport.PRIORITY,
          },
          {
            consultantProfileId: consultant.id,
            duration: SubscriptionPlanDuration.SIX_MONTHS,
            price: faker.number.int({ min: 39900, max: 79900 }), // $399 to $799
            callsPerWeek: 3,
            videoMeetings: 4,
            emailSupport: SubscriptionEmailSupport.DEDICATED,
          },
        ],
      });
    } catch (error) {
      console.error(
        `Failed to create subscription plans for consultant ${consultant.id}:`,
        error
      );
    }
  }
}

async function createWebinarPlans() {
  const consultants = await prisma.consultantProfile.findMany();

  for (const consultant of consultants) {
    try {
      console.log(`Creating webinar plans for consultant: ${consultant.id}`);
      await prisma.webinarPlan.createMany({
        data: [
          {
            consultantProfileId: consultant.id,
            duration: 1, // 1 hour
            price: faker.number.int({ min: 1500, max: 3000 }), // $15 to $30
          },
          {
            consultantProfileId: consultant.id,
            duration: 2, // 2 hours
            price: faker.number.int({ min: 2500, max: 5000 }), // $25 to $50
          },
          {
            consultantProfileId: consultant.id,
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
  }
}

async function createClassPlans() {
  const consultants = await prisma.consultantProfile.findMany();

  for (const consultant of consultants) {
    try {
      console.log(`Creating class plans for consultant: ${consultant.id}`);
      await prisma.classPlan.createMany({
        data: [
          {
            consultantProfileId: consultant.id,
            duration: 4, // 4 weeks
            price: faker.number.int({ min: 19900, max: 39900 }), // $199 to $399
            callsPerWeek: 1,
            videoMeetings: 4,
            emailSupport: ClassEmailSupport.GENERAL,
          },
          {
            consultantProfileId: consultant.id,
            duration: 8, // 8 weeks
            price: faker.number.int({ min: 34900, max: 69900 }), // $349 to $699
            callsPerWeek: 2,
            videoMeetings: 8,
            emailSupport: ClassEmailSupport.PRIORITY,
          },
          {
            consultantProfileId: consultant.id,
            duration: 12, // 12 weeks
            price: faker.number.int({ min: 49900, max: 99900 }), // $499 to $999
            callsPerWeek: 3,
            videoMeetings: 12,
            emailSupport: ClassEmailSupport.DEDICATED,
          },
        ],
      });
    } catch (error) {
      console.error(
        `Failed to create class plans for consultant ${consultant.id}:`,
        error
      );
    }
  }
}

async function createSlotsOfAvailability() {
  const consultants = await prisma.consultantProfile.findMany();

  for (const consultant of consultants) {
    try {
      console.log(
        `Creating slots of availability for consultant: ${consultant.id}`
      );
      const slotType =
        consultant.scheduleType === ScheduleType.WEEKLY
          ? SlotType.WEEKLY
          : SlotType.CUSTOM;

      if (slotType === SlotType.WEEKLY) {
        // Create weekly slots
        for (let i = 0; i < 5; i++) {
          await prisma.slotOfAvailabilty.create({
            data: {
              consultantProfileId: consultant.id,
              dayOfWeek: faker.helpers.arrayElement(Object.values(DayOfWeek)),
              slotStartTimeInUTC: faker.date.future(),
              slotEndTimeInUTC: faker.date.future(),
              slotType: SlotType.WEEKLY,
            },
          });
        }
      } else {
        // Create custom slots
        for (let i = 0; i < 5; i++) {
          await prisma.slotOfAvailabilty.create({
            data: {
              consultantProfileId: consultant.id,
              date: faker.date.future(),
              slotStartTimeInUTC: faker.date.future(),
              slotEndTimeInUTC: faker.date.future(),
              slotType: SlotType.CUSTOM,
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
  }
}

async function createAppointments() {
  const consultees = await prisma.consulteeProfile.findMany();
  const availabilitySlots = await prisma.slotOfAvailabilty.findMany();
  const consultationPlans = await prisma.consultationPlan.findMany();
  const subscriptionPlans = await prisma.subscriptionPlan.findMany();
  const webinarPlans = await prisma.webinarPlan.findMany();
  const classPlans = await prisma.classPlan.findMany();

  for (const consultee of consultees) {
    try {
      console.log(`Creating appointments for consultee: ${consultee.id}`);
      const appointmentType = faker.helpers.arrayElement(
        Object.values(AppointmentsType)
      );
      const availabilitySlot = faker.helpers.arrayElement(availabilitySlots);

      const appointmentRequest = await prisma.slotsOfAppointmentRequest.create({
        data: {
          status: RequestStatus.PENDING,
          slotOfAvailabilityId: availabilitySlot.id,
          appointmentDate: faker.date.future(),
          appointmentStartTimeInUTC: faker.date.future(),
          appointmentEndTimeInUTC: faker.date.future(),
        },
      });

      const appointment = await prisma.slotOfAppointment.create({
        data: {
          consulteeProfileId: consultee.id,
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
  }
}

async function createNewsletters() {
  for (let i = 0; i < 40; i++) {
    try {
      console.log("Creating newsletter subscription");
      await prisma.newsletter.create({
        data: {
          email: faker.internet.email(),
        },
      });
    } catch (error) {
      console.error("Failed to create newsletter subscription:", error);
    }
  }
}

async function seed() {
  await createUsers();
  await createConsultationPlans();
  await createSubscriptionPlans();
  await createWebinarPlans();
  await createClassPlans();
  await createSlotsOfAvailability();
  await createAppointments();
  await createNewsletters();

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
