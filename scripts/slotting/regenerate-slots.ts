import prisma from "../../lib/prisma";
import { createSlotsOfAvailability } from "../../prisma/seedFiles/createSlotsOfAvailability";
import { UserWithProfiles } from "../../prisma/seedFiles/createUsers";

/**
 * Script to regenerate slots with fixed logic after cleaning corrupted data
 */
async function regenerateSlots() {
  console.log("🔄 Regenerating slots with fixed logic...");

  try {
    // Get all consultants that need slots
    const consultants = await prisma.user.findMany({
      where: {
        role: "CONSULTANT",
        consultantProfile: {
          isNot: null,
        },
      },
      include: {
        consultantProfile: true,
      },
    });

    console.log(`Found ${consultants.length} consultants`);

    // Delete existing slots first
    console.log("🗑️  Deleting existing slots...");
    const deletedCustom = await prisma.slotOfAvailabilityCustom.deleteMany({});
    const deletedWeekly = await prisma.slotOfAvailabilityWeekly.deleteMany({});

    console.log(
      `Deleted ${deletedCustom.count} custom slots and ${deletedWeekly.count} weekly slots`,
    );

    // Regenerate slots with fixed logic
    console.log("✨ Creating new slots with fixed logic...");
    await createSlotsOfAvailability(consultants as UserWithProfiles[]);

    console.log("✅ Slots regenerated successfully!");

    // Verify no corrupted slots were created
    console.log("\n🔍 Verifying no corrupted slots were created...");

    const corruptedWeekly = await prisma.slotOfAvailabilityWeekly.count({
      where: {
        slotEndTimeInUTC: {
          lte: prisma.slotOfAvailabilityWeekly.fields.slotStartTimeInUTC,
        },
      },
    });

    const corruptedCustom = await prisma.slotOfAvailabilityCustom.count({
      where: {
        slotEndTimeInUTC: {
          lte: prisma.slotOfAvailabilityCustom.fields.slotStartTimeInUTC,
        },
      },
    });

    if (corruptedWeekly === 0 && corruptedCustom === 0) {
      console.log("✅ No corrupted slots found - regeneration successful!");
    } else {
      console.warn(
        `⚠️  Found ${corruptedWeekly} corrupted weekly slots and ${corruptedCustom} corrupted custom slots`,
      );
    }
  } catch (error) {
    console.error("❌ Error regenerating slots:", error);
    throw error;
  }
}

// Run the regeneration if this script is executed directly
if (require.main === module) {
  regenerateSlots()
    .then(() => {
      console.log("🎉 Regeneration completed successfully!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("💥 Regeneration failed:", error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

export { regenerateSlots };
