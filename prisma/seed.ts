import * as dotenv from "dotenv";
import prisma from "../lib/prisma";
import { createUsers } from "./seedFiles/createUsers";
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
  const startTime = Date.now();

  try {
    console.log("Creating users...");
    const users = await createUsers();
    const consultants = users.filter((user) => user.role === "CONSULTANT");
    const consultees = users.filter((user) => user.role === "CONSULTEE");

    console.log("Creating consultation plans...");
    await createConsultationPlans(consultants);
    
    console.log("Creating subscription plans...");
    await createSubscriptionPlans(consultants);
    
    console.log("Creating webinar plans...");
    await createWebinarPlans(consultants);
    
    console.log("Creating class plans...");
    await createClassPlans(consultants);
    
    console.log("Creating slots of availability...");
    await createSlotsOfAvailability(consultants);
    
    console.log("Creating topics...");
    await createTopics();
    
    console.log("Creating appointments (this may take a while)...");
    await createAppointments(consultees);
    
    console.log("Creating newsletters...");
    await createNewsletters();
    
    console.log("Creating consultant reviews...");
    await createConsultantReviews(consultants, consultees);
    
    console.log("Creating discount codes...");
    await createDiscountCodes();
    
    console.log("Creating payments...");
    await createPayments(users);

    const endTime = Date.now();
    const timeElapsed = (endTime - startTime) / 1000; // time in seconds
    console.log(`✅ Seed data inserted successfully in ${timeElapsed} seconds.`);
  } catch (error) {
    console.error("❌ Error during seed process:", error);
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
