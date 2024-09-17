import { faker } from "@faker-js/faker";
import { DayOfWeek, ScheduleType } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./createUsers";

const NUM_SLOTS_PER_CONSULTANT = 20;

export async function createSlotsOfAvailability(consultants: UserWithProfiles[]) {
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

          await prisma.slotOfAvailabilityWeekly.create({
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

          await prisma.slotOfAvailabilityCustom.create({
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