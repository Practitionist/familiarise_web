import { faker } from "@faker-js/faker";
import { DayOfWeek, ScheduleType } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./createUsers";

const MAX_SLOT_DURATION = 6 * 2; // In 30-min intervals (12)
const MIN_SLOT_DURATION = 1; // In 30-min intervals (1 = 30 mins)
const MIN_BREAK_DURATION = 1; // In 30-min intervals (1 = 30 mins)
const MAX_SLOTS_PER_DAY = 4;

function generateSlotTime(
  existingSlots: Array<{ start: number; end: number }>, // start/end now in 30-min intervals from midnight
) {
  let attempts = 0;
  while (attempts < 50) {
    // Generate random start interval (0-47, representing 00:00, 00:30, ..., 23:30)
    const startInterval = faker.number.int({ min: 0, max: 47 });

    // Generate random duration between 1 and 12 (30 mins to 6 hours)
    const durationInterval = faker.number.int({
      min: MIN_SLOT_DURATION,
      max: MAX_SLOT_DURATION,
    });
    const endInterval = startInterval + durationInterval;

    // Verify overlap (intervals already include break)
    const hasOverlap = existingSlots.some((slot) => {
      return !(
        endInterval + MIN_BREAK_DURATION <= slot.start ||
        startInterval >= slot.end + MIN_BREAK_DURATION
      );
    });

    if (!hasOverlap && endInterval <= 48) {
      // Ensure slot doesn't go past midnight (interval 48)
      return { start: startInterval, end: endInterval };
    }

    attempts++;
  }
  return null;
}

function generateDaySlots() {
  const slots: Array<{ start: number; end: number }> = [];
  const numSlots = faker.number.int({ min: 1, max: MAX_SLOTS_PER_DAY });

  for (let i = 0; i < numSlots; i++) {
    const slot = generateSlotTime(slots);
    if (slot) {
      slots.push(slot);
    }
  }
  return slots.sort((a, b) => a.start - b.start);
}

export async function createSlotsOfAvailability(
  consultants: UserWithProfiles[],
) {
  console.log(
    `Creating slots of availability for ${consultants.length} consultants...`,
  );

  for (let i = 0; i < consultants.length; i++) {
    const consultant = consultants[i];
    if (!consultant.consultantProfile) {
      console.warn(`Skipping consultant ${consultant.id} - no profile found`);
      continue;
    }

    try {
      const slotType = consultant.consultantProfile.scheduleType;

      if (slotType === ScheduleType.WEEKLY) {
        // Create weekly slots for each day
        const daysOfWeek = Object.values(DayOfWeek);

        for (const dayOfWeek of daysOfWeek) {
          const daySlots = generateDaySlots();

          for (const slot of daySlots) {
            // Convert intervals back to hours and minutes
            const startHour = Math.floor(slot.start / 2);
            const startMinute = (slot.start % 2) * 30;
            const endHour = Math.floor(slot.end / 2);
            const endMinute = (slot.end % 2) * 30;

            // For weekly slots, since they represent recurring time patterns, we have a few options:
            //
            // Use a fixed date in the future (like 2025) - Not ideal because:
            // - The slots might appear too far in the future
            // - We'd need to handle date rollovers manually
            //
            // Use 1970 (Unix epoch) - Not ideal because:
            // - Some databases/systems might have issues with dates too far in the past
            // - Could cause confusion with timezone conversions
            //
            // Better approach: Use the next occurrence of each day of the week from today. This is more natural because:
            // - It represents the actual next available slot
            // - Makes it easier to handle timezone conversions
            // - Aligns with how recurring events typically work in calendaring systems
            const today = new Date();
            const daysUntilNext =
              (Object.values(DayOfWeek).indexOf(dayOfWeek) +
                7 -
                today.getUTCDay()) %
              7;
            const nextOccurrence = new Date(today);
            nextOccurrence.setDate(nextOccurrence.getDate() + daysUntilNext);

            // Create the slot times
            const startTime = new Date(nextOccurrence);
            startTime.setUTCHours(startHour, startMinute, 0, 0);

            const endTime = new Date(nextOccurrence);
            endTime.setUTCHours(endHour, endMinute, 0, 0);

            // If end time is before start time, it means the slot crosses midnight
            if (endTime <= startTime) {
              endTime.setDate(endTime.getDate() + 1);
            }

            await prisma.slotOfAvailabilityWeekly.create({
              data: {
                consultantProfileId: consultant.consultantProfile.id,
                dayOfWeekforStartTimeInUTC: dayOfWeek,
                slotStartTimeInUTC: startTime,
                // If slot crosses midnight, end day is next day
                dayOfWeekforEndTimeInUTC:
                  endTime <= startTime
                    ? daysOfWeek[(daysOfWeek.indexOf(dayOfWeek) + 1) % 7]
                    : dayOfWeek,
                slotEndTimeInUTC: endTime,
              },
            });
          }
        }
      } else {
        // Create custom slots for next 7 days
        const startDate = new Date();
        for (let day = 0; day < 7; day++) {
          const date = new Date(startDate);
          date.setDate(date.getDate() + day);

          const daySlots = generateDaySlots();

          for (const slot of daySlots) {
            // Convert intervals back to hours and minutes
            const startHour = Math.floor(slot.start / 2);
            const startMinute = (slot.start % 2) * 30;
            const endHour = Math.floor(slot.end / 2);
            const endMinute = (slot.end % 2) * 30;

            // Create a date for this specific day
            const startTime = new Date(date);
            startTime.setUTCHours(startHour, startMinute, 0, 0);

            const endTime = new Date(startTime);
            endTime.setUTCHours(endHour, endMinute, 0, 0);

            // If end time is before start time, it means the slot crosses midnight
            if (endTime <= startTime) {
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
      }
    } catch (error) {
      console.error(
        `Failed to create slots of availability for consultant ${consultant.id}:`,
        error,
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created slots of availability for ${i + 1} consultants`);
    }
  }
}
