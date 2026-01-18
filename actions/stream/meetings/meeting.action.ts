"use server";

import { z } from "zod";
import prisma from "@/lib/prisma";
import { TSlotOfAppointment } from "@/types/appointment";
import { MeetingSession } from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";

// Input validation schemas
const slotIdSchema = z.string().min(1, "Slot ID is required");
const streamCallIdSchema = z.string().min(1, "Stream Call ID is required");

const slotSchema = z.object({
  id: z.string().min(1),
  startsAt: z.date(),
  endsAt: z.date().nullable().optional(),
  isTentative: z.boolean().optional(),
  appointmentId: z.string().nullable().optional(),
});

/**
 * Finds an existing meeting session in the database by slot ID.
 * @param slotId The ID of the appointment slot.
 * @returns The MeetingSession object if found, otherwise null.
 */
export async function findDbMeetingSessionBySlot(
  slotId: string,
): Promise<MeetingSession | null> {
  // Validate input
  const validatedSlotId = slotIdSchema.parse(slotId);

  try {
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { slotOfAppointmentId: validatedSlotId },
    });

    if (meetingSession) {
      streamLogger.debug("Found existing meeting session", {
        sessionId: meetingSession.id,
        slotId: validatedSlotId,
      });
    } else {
      streamLogger.debug("No existing meeting session found", {
        slotId: validatedSlotId,
      });
    }

    return meetingSession;
  } catch (error) {
    streamLogger.error("Error finding meeting session", error, {
      slotId: validatedSlotId,
    });
    return null;
  }
}

/**
 * Creates a new meeting session in the database.
 * @param slot The appointment slot for which to create the session.
 * @param streamCallId The Stream Call ID to associate with the new session.
 * @returns The newly created MeetingSession object.
 */
export async function createDbMeetingSession(
  slot: TSlotOfAppointment,
  streamCallId: string,
): Promise<MeetingSession> {
  // Validate inputs
  slotSchema.parse({
    id: slot.id,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    isTentative: slot.isTentative,
    appointmentId: slot.appointmentId,
  });
  const validatedStreamCallId = streamCallIdSchema.parse(streamCallId);

  streamLogger.debug("Creating meeting session", {
    slotId: slot.id,
    streamCallId: validatedStreamCallId,
  });

  try {
    const meetingSession = await prisma.meetingSession.create({
      data: {
        streamCallId: validatedStreamCallId,
        platform: "STREAM",
        slotOfAppointment: {
          connect: { id: slot.id },
        },
      },
    });

    streamLogger.info("Meeting session created", {
      sessionId: meetingSession.id,
      slotId: slot.id,
      streamCallId: validatedStreamCallId,
    });

    return meetingSession;
  } catch (error) {
    streamLogger.error("Failed to create meeting session", error, {
      slotId: slot.id,
      streamCallId: validatedStreamCallId,
    });

    if (error instanceof Error) {
      throw new Error(`Failed to create meeting session: ${error.message}`);
    }
    throw new Error(
      "An unknown error occurred while creating the meeting session.",
    );
  }
}

/**
 * Get or create a meeting session for a slot
 * This is an atomic operation that handles race conditions
 * @param slot The appointment slot
 * @param streamCallId The Stream call ID to use if creating new
 * @returns The existing or newly created meeting session
 */
export async function getOrCreateMeetingSession(
  slot: TSlotOfAppointment,
  streamCallId: string,
): Promise<MeetingSession> {
  // First try to find existing
  const existing = await findDbMeetingSessionBySlot(slot.id);
  if (existing) {
    return existing;
  }

  // Create new session (handles race condition with unique constraint)
  return createDbMeetingSession(slot, streamCallId);
}

/**
 * Update a meeting session's Stream call ID
 * Useful when reconnecting to a call
 * @param sessionId The meeting session ID
 * @param streamCallId The new Stream call ID
 * @returns The updated meeting session
 */
export async function updateMeetingSessionCallId(
  sessionId: string,
  streamCallId: string,
): Promise<MeetingSession> {
  const validatedSessionId = z.string().min(1).parse(sessionId);
  const validatedStreamCallId = streamCallIdSchema.parse(streamCallId);

  try {
    const updated = await prisma.meetingSession.update({
      where: { id: validatedSessionId },
      data: { streamCallId: validatedStreamCallId },
    });

    streamLogger.debug("Updated meeting session call ID", {
      sessionId: validatedSessionId,
      streamCallId: validatedStreamCallId,
    });

    return updated;
  } catch (error) {
    streamLogger.error("Failed to update meeting session", error, {
      sessionId: validatedSessionId,
    });
    throw error;
  }
}
