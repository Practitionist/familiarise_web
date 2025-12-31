import { faker } from "@faker-js/faker";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./1a-create-users";

const NUM_WAITLIST_ENTRIES = 75;

export async function createWaitlists(
  users: UserWithProfiles[],
): Promise<void> {
  console.log(`Creating ${NUM_WAITLIST_ENTRIES} waitlist entries...`);

  // Filter to consultees (main users who would join waitlists)
  const consultees = users.filter((user) => user.role === "CONSULTEE");

  if (consultees.length === 0) {
    console.warn("No consultee users found for waitlist creation");
    return;
  }

  // Get all webinars and classes
  const webinars = await prisma.webinar.findMany({
    select: { id: true },
  });

  const classes = await prisma.class.findMany({
    select: { id: true },
  });

  if (webinars.length === 0 && classes.length === 0) {
    console.warn("No webinars or classes found for waitlist creation");
    return;
  }

  // Track existing waitlist entries to avoid duplicates
  const existingEntries = new Set<string>();

  let created = 0;
  let attempts = 0;
  const maxAttempts = NUM_WAITLIST_ENTRIES * 3; // Prevent infinite loops

  while (created < NUM_WAITLIST_ENTRIES && attempts < maxAttempts) {
    attempts++;

    try {
      const user = faker.helpers.arrayElement(consultees);

      // Randomly choose between webinar or class waitlist
      const isWebinar =
        webinars.length > 0 &&
        (classes.length === 0 || faker.datatype.boolean());

      let eventId: string;
      let entryKey: string;
      let createData: any;

      if (isWebinar) {
        const webinar = faker.helpers.arrayElement(webinars);
        eventId = webinar.id;
        entryKey = `user:${user.id}-webinar:${eventId}`;

        // Skip if this combination already exists
        if (existingEntries.has(entryKey)) {
          continue;
        }

        createData = {
          userId: user.id,
          webinarId: eventId,
          joinedAt: faker.date.recent({ days: 30 }),
        };
      } else {
        const classItem = faker.helpers.arrayElement(classes);
        eventId = classItem.id;
        entryKey = `user:${user.id}-class:${eventId}`;

        // Skip if this combination already exists
        if (existingEntries.has(entryKey)) {
          continue;
        }

        createData = {
          userId: user.id,
          classId: eventId,
          joinedAt: faker.date.recent({ days: 30 }),
        };
      }

      // Check database for existing entry
      const existingInDb = await prisma.waitlist.findFirst({
        where: isWebinar
          ? { userId: user.id, webinarId: eventId }
          : { userId: user.id, classId: eventId },
      });

      if (existingInDb) {
        existingEntries.add(entryKey);
        continue;
      }

      await prisma.waitlist.create({
        data: createData,
      });

      existingEntries.add(entryKey);
      created++;

      if (created % 10 === 0) {
        console.log(`Created ${created} waitlist entries...`);
      }
    } catch (error) {
      // Handle unique constraint violations gracefully
      if (
        error instanceof Error &&
        error.message.includes("Unique constraint")
      ) {
        continue;
      }
      console.error(`Failed to create waitlist entry:`, error);
    }
  }

  console.log(`Created ${created} waitlist entries`);
}
