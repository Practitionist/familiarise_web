import { faker } from "@faker-js/faker";
import { Platform } from "@prisma/client";
import prisma from "../../lib/prisma";

// Recording title templates
const RECORDING_TITLES = [
  "Consultation Session Recording",
  "Career Guidance Session",
  "Technical Review Meeting",
  "Mentorship Call Recording",
  "Strategy Discussion",
  "Q&A Session",
  "Follow-up Consultation",
  "Initial Assessment Meeting",
  "Progress Review Session",
  "Goal Setting Discussion",
];

/**
 * Generate passcode for meetings
 */
function generatePasscode(): string {
  return faker.string.numeric(6);
}

/**
 * Generate host keys for consultants
 */
function generateHostKeys(): string[] {
  const numKeys = faker.number.int({ min: 1, max: 3 });
  return Array.from({ length: numKeys }, () =>
    faker.string.alphanumeric(12).toUpperCase(),
  );
}

import { config } from "./config";

// Meeting session volume - configurable via SEED_MODE environment variable
const NUM_MEETING_SESSIONS = config.volumes.meetings;
const NUM_RECORDINGS = Math.floor(
  config.volumes.meetings * config.volumes.recordingsPerSession,
);

export async function createMeetings(): Promise<void> {
  console.log(
    `Creating ${NUM_MEETING_SESSIONS} meeting sessions and ${NUM_RECORDINGS} recordings...`,
  );

  const now = new Date();
  // Seed Meeting rows only for past occurrences so upcoming SCHEDULED occurrences
  // start with meeting: null and exercise provisionAppointmentMeeting on first join.
  const occurrences = await prisma.appointmentOccurrence.findMany({
    where: {
      meeting: null,
      endsAt: { lt: now },
      deletedAt: null,
    },
    include: {
      appointment: {
        include: {
          consultation: true,
          subscription: true,
          webinar: true,
          class: true,
        },
      },
    },
    take: NUM_MEETING_SESSIONS * 2, // Get more than needed to have options
  });

  if (occurrences.length === 0) {
    console.warn(
      "No eligible appointment slots found for meeting session creation",
    );
    return;
  }

  let sessionsCreated = 0;
  let recordingsCreated = 0;

  // Track which slots we've used
  const usedSlotIds = new Set<string>();

  for (let i = 0; i < Math.min(NUM_MEETING_SESSIONS, occurrences.length); i++) {
    const slot = occurrences[i];

    // Skip if slot already used
    if (usedSlotIds.has(slot.id)) {
      continue;
    }

    try {
      const platform: Platform = "STREAM";
      const streamCallId = `occurrence-${slot.id}`;
      const slotEndsAt = new Date(slot.endsAt);

      // Add passcode for some meetings
      const hasPasscode = faker.datatype.boolean({ probability: 0.6 });
      const passcode = hasPasscode ? generatePasscode() : null;

      // Generate host keys
      const hostKeys = generateHostKeys();

      const meeting = await prisma.meeting.create({
        data: {
          streamCallId,
          platform,
          passcode,
          hostKeys,
          appointmentOccurrenceId: slot.id,
          endedAt: slotEndsAt,
          endedReason: "call_ended",
        },
      });

      usedSlotIds.add(slot.id);
      sessionsCreated++;

      // Create recordings for completed/past meetings (about 50% of sessions)
      const isPast = slotEndsAt < now;

      if (
        isPast &&
        recordingsCreated < NUM_RECORDINGS &&
        faker.datatype.boolean({ probability: 0.5 })
      ) {
        const numRecordings = faker.number.int({ min: 1, max: 2 });

        for (let j = 0; j < numRecordings; j++) {
          const title = faker.helpers.arrayElement(RECORDING_TITLES);

          // Duration between 30 and 120 minutes
          const durationInMinutes = faker.number.int({ min: 30, max: 120 });

          // Recording URL (placeholder)
          const recordingUrl = `https://placeholder.com/recordings/${meeting.id}/${faker.string.alphanumeric(16)}.mp4`;

          // Recording date is around the slot time
          const recordedAt = faker.date.between({
            from: new Date(slot.startsAt),
            to: slotEndsAt,
          });

          await prisma.recording.create({
            data: {
              title: j > 0 ? `${title} (Part ${j + 1})` : title,
              recordingUrl,
              durationInMinutes,
              recordedAt,
              meetingId: meeting.id,
            },
          });

          recordingsCreated++;
        }
      }

      if (sessionsCreated % 20 === 0) {
        console.log(
          `Created ${sessionsCreated} meeting sessions, ${recordingsCreated} recordings...`,
        );
      }
    } catch (error) {
      // Handle unique constraint violations
      if (
        error instanceof Error &&
        error.message.includes("Unique constraint")
      ) {
        continue;
      }
      console.error(`Failed to create meeting session:`, error);
    }
  }

  console.log(
    `Created ${sessionsCreated} meeting sessions with ${recordingsCreated} recordings`,
  );
}
