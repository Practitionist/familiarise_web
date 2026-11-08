import { faker } from "@faker-js/faker";
import { NewsletterSource, NewsletterStatus } from "@prisma/client";
import prisma from "../../lib/prisma";
import { config } from "./config";

const NUM_SUBSCRIBERS = config.volumes.newsletterSubscribers;

// Roughly what a real list looks like: mostly confirmed, a tail of people who
// never clicked the confirmation link, a few opt-outs, the occasional bounce.
const STATUS_WEIGHTS: Array<[NewsletterStatus, number]> = [
  [NewsletterStatus.SUBSCRIBED, 70],
  [NewsletterStatus.PENDING, 18],
  [NewsletterStatus.UNSUBSCRIBED, 10],
  [NewsletterStatus.BOUNCED, 2],
];

function pickStatus(): NewsletterStatus {
  const roll = faker.number.int({ min: 1, max: 100 });
  let cumulative = 0;
  for (const [status, weight] of STATUS_WEIGHTS) {
    cumulative += weight;
    if (roll <= cumulative) return status;
  }
  return NewsletterStatus.SUBSCRIBED;
}

export async function createNewsletterSubscribers() {
  console.log(`Creating ${NUM_SUBSCRIBERS} newsletter subscribers...`);

  const sources = Object.values(NewsletterSource);

  for (let i = 0; i < NUM_SUBSCRIBERS; i++) {
    const status = pickStatus();
    const createdAt = faker.date.recent({ days: 180 });

    try {
      await prisma.newsletterSubscriber.create({
        data: {
          email: faker.internet.email().toLowerCase(),
          name: faker.datatype.boolean() ? faker.person.fullName() : null,
          status,
          source: faker.helpers.arrayElement(sources),
          tags: faker.helpers.arrayElements(
            ["founder", "student", "enterprise", "india", "beta"],
            { min: 0, max: 2 },
          ),
          createdAt,
          confirmedAt:
            status === NewsletterStatus.SUBSCRIBED ||
            status === NewsletterStatus.UNSUBSCRIBED
              ? faker.date.between({ from: createdAt, to: new Date() })
              : null,
          unsubscribedAt:
            status === NewsletterStatus.UNSUBSCRIBED
              ? faker.date.between({ from: createdAt, to: new Date() })
              : null,
        },
      });
    } catch (error) {
      // Duplicate faker emails are expected at higher volumes; skip and move on.
      console.error("Failed to create newsletter subscriber:", error);
    }

    if ((i + 1) % 20 === 0 || i === NUM_SUBSCRIBERS - 1) {
      console.log(`Created ${i + 1} newsletter subscribers`);
    }
  }
}
