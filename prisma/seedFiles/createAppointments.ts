import { faker } from "@faker-js/faker";
import { AppointmentsType } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./createUsers";

const NUM_APPOINTMENTS = 200;

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

  const topics = await prisma.topic.findMany();

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
      console.warn(`No slot data available for appointment ${i + 1}. This is likely due to insufficient slots created. Skipping appointment creation...`);
      continue;
    }

    try {
      const appointmentType = faker.helpers.arrayElement(
        Object.values(AppointmentsType)
      );

      await prisma.$transaction(async (prisma) => {
        const appointmentData: any = {
          appointmentType: appointmentType,
          slotOfAppointment: {
            create: {
              consulteeProfile: {
                connect: { id: consultee.consulteeProfile!.id }
              },
              appointmentStartTimeInUTC: slotData.type === 'weekly' ? slotData.slot.slotStartTimeInUTC : slotData.slot.slotStartTimeInUTC,
              appointmentEndTimeInUTC: slotData.type === 'weekly' ? slotData.slot.slotEndTimeInUTC : slotData.slot.slotEndTimeInUTC,
              appointmentsType: appointmentType,
              ...(slotData.type === 'weekly'
                ? { slotOfAvailabilityWeekly: { connect: { id: slotData.slot.id } } }
                : { slotOfAvailabilityCustom: { connect: { id: slotData.slot.id } } }
              ),
            },
          },
        };

        switch (appointmentType) {
          case AppointmentsType.CONSULTATION:
            appointmentData.consultation = {
              create: {
                consultationPlan: { connect: { id: faker.helpers.arrayElement(consultationPlans).id } },
                requestedBy: {
                  connect: { id: consultee.consulteeProfile!.id }
                },
              },
            };
            break;
          case AppointmentsType.SUBSCRIPTION:
            appointmentData.subscription = {
              create: {
                plan: { connect: { id: faker.helpers.arrayElement(subscriptionPlans).id } },
                startDate: faker.date.recent(),
                endDate: faker.date.future(),
                requestedBy: {
                  connect: { id: consultee.consulteeProfile!.id }
                },
              },
            };
            break;
          case AppointmentsType.WEBINAR:
            appointmentData.webinar = {
              create: {
                webinarPlan: { connect: { id: faker.helpers.arrayElement(webinarPlans).id } },
                title: faker.lorem.sentence(),
                description: faker.lorem.paragraph(),
                scheduledAt: faker.date.future(),
                durationInHours: faker.number.float({
                  min: 1,
                  max: 3,
                  multipleOf: 0.5,
                }),
                topics: {
                  connect: faker.helpers.arrayElements(topics, { min: 1, max: 3 }).map(topic => ({ id: topic.id })),
                },
              },
            };
            break;
          case AppointmentsType.CLASS:
            const classPlan = faker.helpers.arrayElement(classPlans);
            appointmentData.class = {
              create: {
                classPlans: {
                  connect: { id: classPlan.id }
                },
                title: faker.lorem.sentence(),
                description: faker.lorem.paragraph(),
                startDate: faker.date.recent(),
                endDate: faker.date.future(),
                topics: {
                  connect: faker.helpers.arrayElements(topics, { min: 1, max: 5 }).map(topic => ({ id: topic.id })),
                },
              },
            };
            break;
        }

        await prisma.appointment.create({
          data: appointmentData,
        });
      });
    } catch (error) {
      console.error(
        `Failed to create appointment for consultee ${consultee.id}:
`,
        error
      );
    }
    if ((i + 1) % 20 === 0 || i === NUM_APPOINTMENTS - 1) {
      console.log(`Created ${i + 1} appointments`);
    }
  }
}
