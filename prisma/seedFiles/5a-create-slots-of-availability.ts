import { faker } from "@faker-js/faker";
import { DayOfWeek, ScheduleType } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./1a-create-users";

const MAX_SLOT_DURATION = 6 * 2; // In 30-min intervals (12)
const MIN_SLOT_DURATION = 1; // In 30-min intervals (1 = 30 mins)
const MIN_BREAK_DURATION = 1; // In 30-min intervals (1 = 30 mins)
const MAX_SLOTS_PER_DAY = 4;

/**
 * Convert hours and minutes to minutes since midnight UTC (0-1439)
 */
function toMinutesSinceMidnight(hour: number, minute: number): number {
  return hour * 60 + minute;
}

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
        // Create weekly slots for each day with business hours focus
        const weeklySlots = [];

        // Define business hours (9 AM - 6 PM)
        const businessHours = [
          { hour: 9, minute: 0 }, // 9:00 AM
          { hour: 10, minute: 0 }, // 10:00 AM
          { hour: 11, minute: 0 }, // 11:00 AM
          { hour: 14, minute: 0 }, // 2:00 PM
          { hour: 15, minute: 0 }, // 3:00 PM
          { hour: 16, minute: 0 }, // 4:00 PM
          { hour: 17, minute: 0 }, // 5:00 PM
        ];

        // Create slots for weekdays (Monday to Friday)
        const weekdays = [
          DayOfWeek.MONDAY,
          DayOfWeek.TUESDAY,
          DayOfWeek.WEDNESDAY,
          DayOfWeek.THURSDAY,
          DayOfWeek.FRIDAY,
        ];

        for (const dayOfWeek of weekdays) {
          // Select 3-5 time slots per day for business hours
          const slotsPerDay = faker.number.int({ min: 3, max: 5 });
          const selectedHours = faker.helpers.arrayElements(
            businessHours,
            slotsPerDay,
          );

          for (const timeSlot of selectedHours) {
            const startMinutes = toMinutesSinceMidnight(
              timeSlot.hour,
              timeSlot.minute,
            );

            weeklySlots.push({
              consultantProfileId: consultant.consultantProfile.id,
              startDay: dayOfWeek,
              endDay: dayOfWeek, // Same day since it's a 1-hour slot
              startTimeUtc: startMinutes,
              endTimeUtc: startMinutes + 60, // 1 hour duration (60 minutes)
            });
          }
        }

        // Add some weekend slots for consultants who work weekends (20% chance)
        if (faker.number.int({ min: 1, max: 5 }) === 1) {
          const weekendDays = [DayOfWeek.SATURDAY, DayOfWeek.SUNDAY];
          for (const dayOfWeek of weekendDays) {
            const slotsPerDay = faker.number.int({ min: 1, max: 3 });
            const selectedHours = faker.helpers.arrayElements(
              businessHours.slice(0, 4),
              slotsPerDay,
            ); // Fewer weekend slots

            for (const timeSlot of selectedHours) {
              const startMinutes = toMinutesSinceMidnight(
                timeSlot.hour,
                timeSlot.minute,
              );

              weeklySlots.push({
                consultantProfileId: consultant.consultantProfile.id,
                startDay: dayOfWeek,
                endDay: dayOfWeek, // Same day since it's a 1-hour slot
                startTimeUtc: startMinutes,
                endTimeUtc: startMinutes + 60, // 1 hour duration (60 minutes)
              });
            }
          }
        }

        await prisma.slotOfAvailabilityWeekly.createMany({
          data: weeklySlots,
        });
      } else {
        // Create custom slots for the next 3 months
        const customSlots = [];
        const startDate = new Date();
        const endDate = new Date(
          startDate.getTime() + 90 * 24 * 60 * 60 * 1000,
        ); // 3 months

        // Business hours for custom slots
        const businessHours = [
          { hour: 9, minute: 0 },
          { hour: 10, minute: 0 },
          { hour: 11, minute: 0 },
          { hour: 14, minute: 0 },
          { hour: 15, minute: 0 },
          { hour: 16, minute: 0 },
          { hour: 17, minute: 0 },
        ];

        // Create 2-4 slots per week for 3 months
        const totalWeeks = 12;
        const slotsPerWeek = faker.number.int({ min: 2, max: 4 });

        for (let week = 0; week < totalWeeks; week++) {
          for (let slot = 0; slot < slotsPerWeek; slot++) {
            const weekStart = new Date(
              startDate.getTime() + week * 7 * 24 * 60 * 60 * 1000,
            );
            const dayOffset = faker.number.int({ min: 0, max: 6 }); // Random day of week
            const slotDate = new Date(
              weekStart.getTime() + dayOffset * 24 * 60 * 60 * 1000,
            );

            const timeSlot = faker.helpers.arrayElement(businessHours);
            // Set time in UTC to ensure consistent timezone handling
            slotDate.setUTCHours(timeSlot.hour, timeSlot.minute, 0, 0);

            if (slotDate > startDate && slotDate < endDate) {
              customSlots.push({
                consultantProfileId: consultant.consultantProfile.id,
                availabilityStartsAt: slotDate,
                availabilityEndsAt: new Date(
                  slotDate.getTime() + 60 * 60 * 1000,
                ),
              });
            }
          }
        }

        await prisma.slotOfAvailabilityCustom.createMany({
          data: customSlots,
        });
      }
    } catch (error) {
      console.error(
        `Failed to create slots for consultant ${consultant.id}:`,
        error,
      );
    }

    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created availability slots for ${i + 1} consultants`);
    }
  }
}
