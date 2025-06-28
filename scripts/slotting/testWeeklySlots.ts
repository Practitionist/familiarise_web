import prisma from "../../lib/prisma";
import {
  processAvailabilitySlots,
  WeeklySlot,
  CustomSlot,
  AppointmentSlot,
} from "../../utils/timeSlotsProcessing";

/**
 * Script to test weekly slots processing with the fixed logic
 */
async function testWeeklySlots() {
  console.log("🔍 Testing weekly slots processing...");

  try {
    // Find a consultant with weekly schedule type
    const weeklyConsultant = await prisma.consultantProfile.findFirst({
      where: {
        scheduleType: "WEEKLY",
      },
      include: {
        user: { select: { name: true, currentTimezone: true } },
        slotsOfAvailabilityWeekly: true,
        slotsOfAvailabilityCustom: true,
      },
    });

    if (!weeklyConsultant) {
      console.log("❌ No consultant with WEEKLY schedule type found");
      return;
    }

    console.log(`✅ Found weekly consultant: ${weeklyConsultant.user.name}`);
    console.log(`📍 Consultant ID: ${weeklyConsultant.id}`);
    console.log(`🌍 Timezone: ${weeklyConsultant.user.currentTimezone}`);
    console.log(
      `📅 Weekly slots count: ${weeklyConsultant.slotsOfAvailabilityWeekly.length}`,
    );

    // Show raw weekly slots from database
    console.log("\n📋 Raw weekly slots from database:");
    weeklyConsultant.slotsOfAvailabilityWeekly.forEach((slot, index) => {
      console.log(`  Slot ${index + 1}:`);
      console.log(`    Day: ${slot.dayOfWeekforStartTimeInUTC}`);
      console.log(`    Start: ${slot.slotStartTimeInUTC.toISOString()}`);
      console.log(`    End: ${slot.slotEndTimeInUTC.toISOString()}`);
      console.log(
        `    Start Time: ${slot.slotStartTimeInUTC.getUTCHours()}:${slot.slotStartTimeInUTC.getUTCMinutes().toString().padStart(2, "0")}`,
      );
      console.log(
        `    End Time: ${slot.slotEndTimeInUTC.getUTCHours()}:${slot.slotEndTimeInUTC.getUTCMinutes().toString().padStart(2, "0")}`,
      );
    });

    // Test the processing logic
    const startDate = new Date("2025-06-23T00:00:00.000Z");
    const endDate = new Date("2025-06-29T23:59:59.999Z");
    const timezone =
      weeklyConsultant.user.currentTimezone || "America/New_York";

    console.log(
      `\n🔧 Processing slots for date range ${startDate.toISOString()} to ${endDate.toISOString()}`,
    );
    console.log(`🌍 Using timezone: ${timezone}`);

    // Convert to utility interfaces
    const weeklySlots: WeeklySlot[] =
      weeklyConsultant.slotsOfAvailabilityWeekly.map((slot) => ({
        id: slot.id,
        dayOfWeekforStartTimeInUTC: slot.dayOfWeekforStartTimeInUTC,
        slotStartTimeInUTC: slot.slotStartTimeInUTC,
        dayOfWeekforEndTimeInUTC: slot.dayOfWeekforEndTimeInUTC,
        slotEndTimeInUTC: slot.slotEndTimeInUTC,
      }));

    const customSlots: CustomSlot[] = [];
    const appointmentSlots: AppointmentSlot[] = [];

    // Process the slots using our fixed logic
    const processedSlots = processAvailabilitySlots(
      weeklySlots,
      customSlots,
      appointmentSlots,
      startDate,
      endDate,
      timezone,
    );

    console.log(
      `\n✨ Processed ${Object.keys(processedSlots).length} days with slots:`,
    );

    Object.entries(processedSlots).forEach(([date, slots]) => {
      console.log(`\n📅 ${date}:`);
      slots.forEach((slot, index) => {
        console.log(
          `  Slot ${index + 1}: ${slot.localStartTime} - ${slot.localEndTime} (${slot.type})`,
        );
        console.log(
          `    UTC: ${slot.slotStartTimeInUTC} - ${slot.slotEndTimeInUTC}`,
        );
      });
    });
  } catch (error) {
    console.error("❌ Error testing weekly slots:", error);
    throw error;
  }
}

// Run the test if this script is executed directly
if (require.main === module) {
  testWeeklySlots()
    .then(() => {
      console.log("🎉 Test completed successfully!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("💥 Test failed:", error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

export { testWeeklySlots };
