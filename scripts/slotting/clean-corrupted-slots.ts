import prisma from "../../lib/prisma";

/**
 * Script to clean up corrupted slots where endTime <= startTime
 */
async function cleanCorruptedSlots() {
  console.log("🔍 Identifying corrupted slots...");

  try {
    // Find corrupted weekly slots
    const corruptedWeeklySlots = await prisma.slotOfAvailabilityWeekly.findMany(
      {
        where: {
          slotEndTimeInUTC: {
            lte: prisma.slotOfAvailabilityWeekly.fields.slotStartTimeInUTC,
          },
        },
      },
    );

    // Find corrupted custom slots
    const corruptedCustomSlots = await prisma.slotOfAvailabilityCustom.findMany(
      {
        where: {
          slotEndTimeInUTC: {
            lte: prisma.slotOfAvailabilityCustom.fields.slotStartTimeInUTC,
          },
        },
      },
    );

    console.log(`Found ${corruptedWeeklySlots.length} corrupted weekly slots`);
    console.log(`Found ${corruptedCustomSlots.length} corrupted custom slots`);

    if (
      corruptedWeeklySlots.length === 0 &&
      corruptedCustomSlots.length === 0
    ) {
      console.log("✅ No corrupted slots found!");
      return;
    }

    // Log some examples of corrupted data
    console.log("\n📋 Examples of corrupted slots:");
    corruptedWeeklySlots.slice(0, 3).forEach((slot, index) => {
      console.log(`Weekly Slot ${index + 1}:`);
      console.log(`  ID: ${slot.id}`);
      console.log(`  Start: ${slot.slotStartTimeInUTC.toISOString()}`);
      console.log(`  End: ${slot.slotEndTimeInUTC.toISOString()}`);
    });

    corruptedCustomSlots.slice(0, 3).forEach((slot, index) => {
      console.log(`Custom Slot ${index + 1}:`);
      console.log(`  ID: ${slot.id}`);
      console.log(`  Start: ${slot.slotStartTimeInUTC.toISOString()}`);
      console.log(`  End: ${slot.slotEndTimeInUTC.toISOString()}`);
    });

    console.log("\n🗑️  Deleting corrupted slots...");

    // Delete corrupted weekly slots
    if (corruptedWeeklySlots.length > 0) {
      const deletedWeekly = await prisma.slotOfAvailabilityWeekly.deleteMany({
        where: {
          id: {
            in: corruptedWeeklySlots.map((slot) => slot.id),
          },
        },
      });
      console.log(`Deleted ${deletedWeekly.count} corrupted weekly slots`);
    }

    // Delete corrupted custom slots
    if (corruptedCustomSlots.length > 0) {
      const deletedCustom = await prisma.slotOfAvailabilityCustom.deleteMany({
        where: {
          id: {
            in: corruptedCustomSlots.map((slot) => slot.id),
          },
        },
      });
      console.log(`Deleted ${deletedCustom.count} corrupted custom slots`);
    }

    console.log("✅ Corrupted slots cleaned up successfully!");

    // Also clean up any appointments that might reference corrupted slots
    console.log("\n🔍 Checking for appointments with corrupted slot times...");

    const corruptedAppointmentSlots = await prisma.slotOfAppointment.findMany({
      where: {
        slotEndTimeInUTC: {
          lte: prisma.slotOfAppointment.fields.slotStartTimeInUTC,
        },
      },
    });

    if (corruptedAppointmentSlots.length > 0) {
      console.log(
        `Found ${corruptedAppointmentSlots.length} corrupted appointment slots`,
      );

      // Delete corrupted appointment slots
      const deletedAppointmentSlots = await prisma.slotOfAppointment.deleteMany(
        {
          where: {
            id: {
              in: corruptedAppointmentSlots.map((slot) => slot.id),
            },
          },
        },
      );
      console.log(
        `Deleted ${deletedAppointmentSlots.count} corrupted appointment slots`,
      );
    } else {
      console.log("✅ No corrupted appointment slots found!");
    }
  } catch (error) {
    console.error("❌ Error cleaning corrupted slots:", error);
    throw error;
  }
}

// Run the cleanup if this script is executed directly
if (require.main === module) {
  cleanCorruptedSlots()
    .then(() => {
      console.log("🎉 Cleanup completed successfully!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("💥 Cleanup failed:", error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

export { cleanCorruptedSlots };
