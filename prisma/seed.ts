import * as dotenv from "dotenv";
import prisma from "../lib/prisma";
import {
  createUsers,
  createWorkExperiences,
  createCertifications,
  createConsultantEducation,
  createConsulteeEducation,
} from "./seedFiles/createUsers";
import { createConsultationPlans } from "./seedFiles/createConsultationPlans";
import { createSubscriptionPlans } from "./seedFiles/createSubscriptionPlans";
import { createWebinarPlans } from "./seedFiles/createWebinarPlans";
import { createClassPlans } from "./seedFiles/createClassPlans";
import { createSlotsOfAvailability } from "./seedFiles/createSlotsOfAvailability";
import { createTopics } from "./seedFiles/createTopics";
import { createAppointments } from "./seedFiles/createAppointments";
import { createNewsletters } from "./seedFiles/createNewsletters";
import { createConsultantReviews } from "./seedFiles/createConsultantReviews";
import { createDiscountCodes } from "./seedFiles/createDiscountCodes";
import { createPayments } from "./seedFiles/createPayments";

dotenv.config({ path: ".env" });

async function seed() {
  console.log("Starting seed process...");
  console.log("=".repeat(60));
  const startTime = Date.now();

  try {
    // Phase 1: Core entities (users and profiles)
    console.log("\n[Phase 1] Creating users and profiles...");
    const users = await createUsers();
    const consultants = users.filter((user) => user.role === "CONSULTANT");
    const consultees = users.filter((user) => user.role === "CONSULTEE");
    const admins = users.filter((user) => user.role === "ADMIN");
    const staff = users.filter((user) => user.role === "STAFF");

    console.log(`  Created ${consultants.length} consultants`);
    console.log(`  Created ${consultees.length} consultees`);
    console.log(`  Created ${admins.length} admins`);
    console.log(`  Created ${staff.length} staff members`);

    // Phase 2: Professional background (for consultants)
    console.log("\n[Phase 2] Creating professional background data...");
    console.log("Creating work experiences...");
    await createWorkExperiences(consultants);

    console.log("Creating certifications...");
    await createCertifications(consultants);

    console.log("Creating consultant education records...");
    await createConsultantEducation(consultants);

    console.log("Creating consultee education history...");
    await createConsulteeEducation(consultees);

    // Phase 3: Topics (needed for webinars and classes)
    console.log("\n[Phase 3] Creating topics...");
    await createTopics();

    // Phase 4: Plans and offerings
    console.log("\n[Phase 4] Creating plans and offerings...");
    console.log("Creating consultation plans...");
    await createConsultationPlans(consultants);

    console.log("Creating subscription plans...");
    await createSubscriptionPlans(consultants);

    console.log("Creating webinar plans...");
    await createWebinarPlans(consultants);

    console.log("Creating class plans...");
    await createClassPlans(consultants);

    // Phase 5: Availability
    console.log("\n[Phase 5] Creating availability slots...");
    await createSlotsOfAvailability(consultants);

    // Phase 6: Appointments and bookings
    console.log("\n[Phase 6] Creating appointments (this may take a while)...");
    await createAppointments(consultees);

    // Phase 7: Engagement data
    console.log("\n[Phase 7] Creating engagement data...");
    console.log("Creating newsletters...");
    await createNewsletters();

    console.log("Creating consultant reviews...");
    await createConsultantReviews(consultants, consultees);

    // Phase 8: Payment-related data
    console.log("\n[Phase 8] Creating payment-related data...");
    console.log("Creating discount codes...");
    await createDiscountCodes();

    console.log("Creating payments...");
    await createPayments(users);

    // Summary
    const endTime = Date.now();
    const timeElapsed = (endTime - startTime) / 1000;
    console.log("\n" + "=".repeat(60));
    console.log("SEED COMPLETED SUCCESSFULLY");
    console.log("=".repeat(60));
    console.log(`\nTotal time: ${timeElapsed.toFixed(2)} seconds`);
    console.log("\nSummary:");
    console.log(`  - Users: ${users.length}`);
    console.log(`    - Consultants: ${consultants.length}`);
    console.log(`    - Consultees: ${consultees.length}`);
    console.log(`    - Staff: ${staff.length}`);
    console.log(`    - Admins: ${admins.length}`);
  } catch (error) {
    console.error("\n" + "=".repeat(60));
    console.error("SEED FAILED");
    console.error("=".repeat(60));
    console.error("Error during seed process:", error);
    throw error;
  }
}

seed()
  .catch((e) => {
    console.error("Error in seed function:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
