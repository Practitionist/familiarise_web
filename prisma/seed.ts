import "dotenv/config";
import prisma from "../lib/prisma";
import { printConfigSummary, getSeedMode } from "./seedFiles/config";

// Phase 1: Core entities
import { createUsers } from "./seedFiles/1a-create-users";

// Phase 2: Professional background
import { createWorkExperiences } from "./seedFiles/2a-create-work-experiences";
import { createCertifications } from "./seedFiles/2b-create-certifications";
import { createConsultantEducation } from "./seedFiles/2c-create-consultant-education";
import { createConsulteeEducation } from "./seedFiles/2d-create-consultee-education";

// Phase 3: Topics
import { createTopics } from "./seedFiles/3a-create-topics";

// Phase 4: Plans
import { createConsultationPlans } from "./seedFiles/4a-create-consultation-plans";
import { createSubscriptionPlans } from "./seedFiles/4b-create-subscription-plans";
import { createWebinarPlans } from "./seedFiles/4c-create-webinar-plans";
import { createClassPlans } from "./seedFiles/4d-create-class-plans";

// Phase 5: Availability
import { createSlotsOfAvailability } from "./seedFiles/5a-create-slots-of-availability";

// Phase 6: Appointments
import { createAppointments } from "./seedFiles/6a-create-appointments";

// Phase 7: Engagement
import { createNewsletters } from "./seedFiles/7a-create-newsletters";
import { createConsultantReviews } from "./seedFiles/7b-create-consultant-reviews";

// Phase 8: Payments
import { createDiscountCodes } from "./seedFiles/8a-create-discount-codes";
import { createPayments } from "./seedFiles/8b-create-payments";

// Phase 9: Support & Feedback
import { createFeedbacks } from "./seedFiles/9a-create-feedbacks";
import { createSupportTickets } from "./seedFiles/9b-create-support-tickets";

// Phase 10: Waitlists
import { createWaitlists } from "./seedFiles/10a-create-waitlists";

// Phase 11: Documents & Meetings
import { createAppointmentDocuments } from "./seedFiles/11a-create-appointment-documents";
import { createMeetingSessions } from "./seedFiles/11b-create-meeting-sessions";

// Phase 12: Payment Extensions
import { createRefunds } from "./seedFiles/12a-create-refunds";
import { createDisputes } from "./seedFiles/12b-create-disputes";

// Phase 13: Payout System
import { createPayoutAccounts } from "./seedFiles/13a-create-payout-accounts";
import { createConsultantEarnings } from "./seedFiles/13b-create-consultant-earnings";
import { createPayouts } from "./seedFiles/13c-create-payouts";
import { createInvoices } from "./seedFiles/13d-create-invoices";

// Phase 14: Referrals & Collaborators
import { createReferralCodes } from "./seedFiles/14a-create-referral-codes";
import { createCollaborators } from "./seedFiles/14b-create-collaborators";

async function seed() {
  console.log("Starting seed process...");

  // Print configuration summary based on SEED_MODE
  printConfigSummary();

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

    // Phase 9: Support & Feedback
    console.log("\n[Phase 9] Creating support & feedback data...");
    console.log("Creating feedbacks...");
    await createFeedbacks(users);

    console.log("Creating support tickets...");
    await createSupportTickets(users);

    // Phase 10: Waitlists
    console.log("\n[Phase 10] Creating waitlists...");
    await createWaitlists(users);

    // Phase 11: Documents & Meetings
    console.log("\n[Phase 11] Creating documents & meeting sessions...");
    console.log("Creating appointment documents...");
    await createAppointmentDocuments();

    console.log("Creating meeting sessions...");
    await createMeetingSessions();

    // Phase 12: Payment Extensions
    console.log("\n[Phase 12] Creating payment extensions...");
    console.log("Creating refunds...");
    await createRefunds();

    console.log("Creating disputes...");
    await createDisputes();

    // Phase 13: Payout System
    console.log("\n[Phase 13] Creating payout system data...");
    console.log("Creating payout accounts...");
    await createPayoutAccounts();

    console.log("Creating consultant earnings...");
    await createConsultantEarnings();

    console.log("Creating payouts...");
    await createPayouts();

    console.log("Creating invoices...");
    await createInvoices();

    // Phase 14: Referrals & Collaborators
    console.log("\n[Phase 14] Creating referrals & collaborators...");
    console.log("Creating referral codes...");
    await createReferralCodes();

    console.log("Creating collaborators...");
    await createCollaborators();

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
