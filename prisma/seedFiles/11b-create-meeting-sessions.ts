import { faker } from "@faker-js/faker";
import { Platform } from "@prisma/client";
import prisma from "../../lib/prisma";

// Platform distribution: 80% STREAM, 10% ZOOM, 5% GOOGLE_MEET, 5% others
const PLATFORM_WEIGHTS: { platform: Platform; weight: number }[] = [
  { platform: "STREAM", weight: 80 },
  { platform: "ZOOM", weight: 10 },
  { platform: "GOOGLE_MEET", weight: 5 },
  { platform: "MICROSOFT_TEAMS", weight: 3 },
  { platform: "CUSTOM", weight: 2 },
];

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

function getWeightedPlatform(): Platform {
  const totalWeight = PLATFORM_WEIGHTS.reduce(
    (sum, item) => sum + item.weight,
    0,
  );
  let random = faker.number.int({ min: 1, max: totalWeight });

  for (const item of PLATFORM_WEIGHTS) {
    random -= item.weight;
    if (random <= 0) {
      return item.platform;
    }
  }
  return "STREAM";
}

/**
 * Generate Stream-compatible call ID
 * Format: call_{uuid} to match Stream's expected format
 */
function generateStreamCallId(): string {
  const uuid = faker.string.uuid();
  return `call_${uuid}`;
}

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

const NUM_MEETING_SESSIONS = 150;
const NUM_RECORDINGS = 75;

export async function createMeetingSessions(): Promise<void> {
  console.log(
    `Creating ${NUM_MEETING_SESSIONS} meeting sessions and ${NUM_RECORDINGS} recordings...`,
  );

  // Get slots of appointments that can have meeting sessions
  const slotsOfAppointment = await prisma.slotOfAppointment.findMany({
    where: {
      meetingSession: null, // Only slots without existing meeting sessions
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

  if (slotsOfAppointment.length === 0) {
    console.warn(
      "No eligible appointment slots found for meeting session creation",
    );
    return;
  }

  let sessionsCreated = 0;
  let recordingsCreated = 0;

  // Track which slots we've used
  const usedSlotIds = new Set<string>();

  for (
    let i = 0;
    i < Math.min(NUM_MEETING_SESSIONS, slotsOfAppointment.length);
    i++
  ) {
    const slot = slotsOfAppointment[i];

    // Skip if slot already used
    if (usedSlotIds.has(slot.id)) {
      continue;
    }

    try {
      const platform = getWeightedPlatform();

      // Generate Stream-compatible call ID as per user preference
      const streamCallId = generateStreamCallId();

      // Add passcode for some meetings
      const hasPasscode = faker.datatype.boolean({ probability: 0.6 });
      const passcode = hasPasscode ? generatePasscode() : null;

      // Generate host keys
      const hostKeys = generateHostKeys();

      const meetingSession = await prisma.meetingSession.create({
        data: {
          streamCallId,
          platform,
          passcode,
          hostKeys,
          slotOfAppointmentId: slot.id,
        },
      });

      usedSlotIds.add(slot.id);
      sessionsCreated++;

      // Create recordings for completed/past meetings (about 50% of sessions)
      const slotEndsAt = new Date(slot.endsAt);
      const isPast = slotEndsAt < new Date();

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
          const recordingUrl = `https://placeholder.com/recordings/${meetingSession.id}/${faker.string.alphanumeric(16)}.mp4`;

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
              meetingSessionId: meetingSession.id,
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
