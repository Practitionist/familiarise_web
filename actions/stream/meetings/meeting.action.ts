"use server";

import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { getMaintenanceState } from "@/lib/maintenance";
/**
 * Minimal slot interface for database meeting session operations.
 * Matches the MeetingSlot interface from lib/meeting.ts.
 */
interface MeetingSlot {
  id: string;
  startsAt: Date | string;
  endsAt: Date | string | null;
  isTentative?: boolean;
  appointmentId?: string | null;
}
import { MeetingSession } from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";

// Input validation schemas
const slotIdSchema = z.string().min(1, "Slot ID is required");
const streamCallIdSchema = z.string().min(1, "Stream Call ID is required");

/** Only what the anchor walk and `MeetingSlot` need — see #1061. */
const anchorSlotSelect = {
  id: true,
  startsAt: true,
  endsAt: true,
  isTentative: true,
  appointmentId: true,
} as const;

export type AnchorSlot = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  appointmentId: string;
};

const slotSchema = z.object({
  id: z.string().min(1),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().optional(),
  isTentative: z.boolean().optional(),
  appointmentId: z.string().nullable().optional(),
});

/**
 * Resolves the slot row a session's video room is keyed to (#1061).
 *
 * A booking longer than 30 minutes is stored as N consecutive rows, and the
 * three dashboard surfaces each hand us a different one — so the room has to
 * be anchored to the run's FIRST row or the two sides of the same call end up
 * in different Stream rooms. This must be resolved server-side: the planner
 * builds a `MeetingAppointment` carrying a single slot, so the client cannot
 * see the run it belongs to.
 *
 * @param slotId Any row of the session.
 * @returns The anchor row, or null when it cannot be resolved (caller falls
 *   back to the row it was given, preserving today's behaviour).
 */
export async function resolveSessionAnchorSlot(
  slotId: string,
): Promise<AnchorSlot | null> {
  const validatedSlotId = slotIdSchema.parse(slotId);

  try {
    const slot = await prisma.slotOfAppointment.findUnique({
      where: { id: validatedSlotId },
      select: anchorSlotSelect,
    });
    if (!slot) return null;

    // Served by @@index([appointmentId]).
    const siblings = await prisma.slotOfAppointment.findMany({
      where: {
        appointmentId: slot.appointmentId,
        deletedAt: null,
        completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
      },
      orderBy: { startsAt: "asc" },
      select: anchorSlotSelect,
    });

    // The row we were handed is itself dead or soft-deleted — it anchors only
    // itself, which keeps a stale Join click on its existing room.
    let index = siblings.findIndex((s) => s.id === slot.id);
    if (index < 0) return slot;

    while (
      index > 0 &&
      siblings[index - 1].endsAt.getTime() ===
        siblings[index].startsAt.getTime() &&
      siblings[index - 1].isTentative === siblings[index].isTentative
    ) {
      index -= 1;
    }

    return siblings[index];
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to resolve session anchor slot", error, {
      slotId: validatedSlotId,
    });
    return null;
  }
}

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
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
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
  slot: MeetingSlot,
  streamCallId: string,
): Promise<MeetingSession> {
  // Block new call creation during maintenance
  const maintenanceState = await getMaintenanceState();
  if (maintenanceState.phase !== "OFF") {
    throw new Error("New calls cannot be created during maintenance.");
  }

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

  let organizationId: string | null = null;
  if (slot.appointmentId) {
    const appointment = await prisma.appointment.findUnique({
      where: { id: slot.appointmentId },
      select: {
        organizationId: true,
      },
    });
    organizationId = appointment?.organizationId ?? null;
  }

  try {
    const meetingSession = await prisma.meetingSession.create({
      data: {
        streamCallId: validatedStreamCallId,
        platform: "STREAM",
        slotOfAppointment: {
          connect: { id: slot.id },
        },
        ...(organizationId
          ? { organization: { connect: { id: organizationId } } }
          : {}),
      },
    });

    streamLogger.info("Meeting session created", {
      sessionId: meetingSession.id,
      slotId: slot.id,
      streamCallId: validatedStreamCallId,
    });

    return meetingSession;
  } catch (error) {
    // Race condition: another caller already created a session for this slot.
    // Return the existing session instead of throwing.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      streamLogger.info(
        "Meeting session already exists (concurrent creation), returning existing",
        { slotId: slot.id },
      );
      const existing = await prisma.meetingSession.findUnique({
        where: { slotOfAppointmentId: slot.id },
      });
      if (existing) return existing;
    }

    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
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
  slot: MeetingSlot,
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
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    streamLogger.error("Failed to update meeting session", error, {
      sessionId: validatedSessionId,
    });
    throw error;
  }
}
