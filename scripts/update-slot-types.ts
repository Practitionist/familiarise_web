#!/usr/bin/env ts-node

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function updateSlotTypes() {
  console.log("Starting slot type update...");

  try {
    // First, let's check total slots
    const totalSlots = await prisma.slotOfAppointment.count();
    console.log(`Found ${totalSlots} total slots`);

    // Update all existing slots to have WEEKLY type by default
    // This is a safe assumption as most slots were probably created from weekly availability
    const result = await prisma.slotOfAppointment.updateMany({
      data: {
        type: "WEEKLY",
      },
    });

    console.log(`Updated ${result.count} slots to have WEEKLY type`);
    console.log("✅ Slot type update completed successfully!");
  } catch (error) {
    console.error("❌ Error updating slot types:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the update
updateSlotTypes();
