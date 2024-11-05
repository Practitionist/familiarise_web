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

  const users = await createUsers();
  const consultants = users.filter((user) => user.role === "CONSULTANT");
  const consultees = users.filter((user) => user.role === "CONSULTEE");

  await createConsultationPlans(consultants);
  await createSubscriptionPlans(consultants);
  await createWebinarPlans(consultants);
  await createClassPlans(consultants);
  await createSlotsOfAvailability(consultants);
  await createTopics();
  await createAppointments(consultees);
  await createNewsletters();
  await createConsultantReviews(consultants, consultees);
  await createDiscountCodes();
  await createPayments(users);

  const endTime = Date.now();
  const timeElapsed = (endTime - startTime) / 1000; // time in seconds
  console.log(`Seed data inserted successfully in ${timeElapsed} seconds.`);
}

seed()
  .catch((e) => {
    console.error("Error in seed function:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
