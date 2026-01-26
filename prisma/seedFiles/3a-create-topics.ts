import { faker } from "@faker-js/faker";
import { Topic } from "@prisma/client";
import prisma from "../../lib/prisma";
import { config } from "./config";

// Topic volume - configurable via SEED_MODE environment variable
const NUM_TOPICS = config.volumes.topics;

export async function createTopics() {
  console.log(`Creating ${NUM_TOPICS} topics...`);
  const topics: Topic[] = [];
  for (let i = 0; i < NUM_TOPICS; i++) {
    try {
      const topic = await prisma.topic.create({
        data: {
          name: faker.lorem.words(3),
        },
      });
      topics.push(topic);
    } catch (error) {
      console.error("Failed to create topic:", error);
    }
  }
  console.log(`Created ${topics.length} topics`);
  return topics;
}
