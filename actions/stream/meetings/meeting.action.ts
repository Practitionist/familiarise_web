"use server";

import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { findSessionRun } from "@/lib/appointments/slots";
import { resolvePlanOwnerIds } from "@/lib/booking/plan-owners";
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

/**
 * Only what `findSessionRun` and `MeetingSlot` need — see #1061.
 * `completionStatus` is selected because the grouping helper, not this file,
 * decides which rows are dead.
 */
const anchorSlotSelect = {
  id: true,
  startsAt: true,
  endsAt: true,
  isTentative: true,
  appointmentId: true,
  completionStatus: true,
} as const;

export type AnchorSlot = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  appointmentId: string;
  completionStatus: string;
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
 * What counts as one session is defined in exactly one place —
 * `groupSlotsIntoRuns` in lib/appointments/slots — and this reads it rather
 * than restating it. The clients compute their join window from the same
 * helper over the same rows, and two drifting definitions of "one session"
 * would put the server's room key and the client's window back out of step,
 * which is the defect this whole change removes.
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

    // Served by @@index([appointmentId]). Only the soft-delete tombstone is
    // filtered here — it is a storage concern the grouping helper has no
    // business knowing about; every session rule is left to the helper.
    const siblings = await prisma.slotOfAppointment.findMany({
      where: { appointmentId: slot.appointmentId, deletedAt: null },
      orderBy: { startsAt: "asc" },
      select: anchorSlotSelect,
    });

    // No run means the row we were handed is itself cancelled, rescheduled or
    // soft-deleted, so it anchors only itself — which keeps a stale Join click
    // on the room it already has.
    return findSessionRun(siblings, slot.id)?.anchor ?? slot;
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
 * Stream's default call roles. `host` carries the elevated capabilities
 * (ending the call, muting, recording); everyone else is a plain member.
 */
const HOST_ROLE = "host";
const GUEST_ROLE = "user";

export type SessionCallMember = { user_id: string; role: string };

export type SessionCallProfile = {
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  offeringTitle: string | null;
  members: SessionCallMember[];
  hostUserIds: string[];
  guestUserIds: string[];
};

/** Consultant identity, deep enough for `resolvePlanOwnerIds` to read it. */
const ownerProfileSelect = { select: { id: true, userId: true } } as const;
const collaboratorsSelect = {
  where: { status: "ACCEPTED" as const },
  select: { consultantProfile: ownerProfileSelect },
} as const;

/**
 * Everything about a session a Stream call should describe itself with — the
 * run's real bounds, the offering it belongs to, and who is hosting it (#1070).
 *
 * Resolved server-side and once, at call-creation time, rather than left to
 * each dashboard surface to infer. Only read on the branch that actually mints
 * a call, so a normal join into an existing room pays nothing for it.
 *
 * @returns null when it cannot be resolved; the caller then creates the call
 *   exactly as it did before, since every field this feeds is additive.
 */
export async function resolveSessionCallProfile(
  anchorSlotId: string,
): Promise<SessionCallProfile | null> {
  const validatedSlotId = slotIdSchema.parse(anchorSlotId);

  try {
    const anchor = await prisma.slotOfAppointment.findUnique({
      where: { id: validatedSlotId },
      select: {
        appointmentId: true,
        appointment: {
          select: {
            appointmentType: true,
            consultation: {
              select: {
                consultationPlan: {
                  select: {
                    title: true,
                    consultantProfile: ownerProfileSelect,
                  },
                },
              },
            },
            subscription: {
              select: {
                subscriptionPlan: {
                  select: {
                    title: true,
                    consultantProfile: ownerProfileSelect,
                  },
                },
              },
            },
            webinar: {
              select: {
                webinarPlan: {
                  select: {
                    title: true,
                    consultantProfile: ownerProfileSelect,
                    collaborators: collaboratorsSelect,
                  },
                },
              },
            },
            class: {
              select: {
                classPlan: {
                  select: {
                    title: true,
                    consultantProfile: ownerProfileSelect,
                    collaborators: collaboratorsSelect,
                  },
                },
              },
            },
            trialSession: {
              select: {
                subscriptionPlan: {
                  select: {
                    title: true,
                    consultantProfile: ownerProfileSelect,
                  },
                },
              },
            },
          },
        },
      },
    });
    const appointment = anchor?.appointment;
    if (!anchor || !appointment) return null;

    const siblings = await prisma.slotOfAppointment.findMany({
      where: { appointmentId: anchor.appointmentId, deletedAt: null },
      orderBy: { startsAt: "asc" },
      select: { ...anchorSlotSelect, user: { select: { id: true } } },
    });
    const run = findSessionRun(siblings, validatedSlotId);
    if (!run) return null;

    // Ownership stays defined by resolvePlanOwnerIds — the same predicate the
    // reschedule and timings routes authorize with. It answers in consultant
    // PROFILE ids, so pair each profile with its user before filtering.
    const profileToUser = new Map<string, string>();
    const remember = (profile?: { id: string; userId: string } | null) => {
      if (profile) profileToUser.set(profile.id, profile.userId);
    };
    remember(appointment.consultation?.consultationPlan?.consultantProfile);
    remember(appointment.subscription?.subscriptionPlan?.consultantProfile);
    remember(appointment.webinar?.webinarPlan?.consultantProfile);
    remember(appointment.class?.classPlan?.consultantProfile);
    remember(appointment.trialSession?.subscriptionPlan?.consultantProfile);
    for (const collaborator of [
      ...(appointment.webinar?.webinarPlan?.collaborators ?? []),
      ...(appointment.class?.classPlan?.collaborators ?? []),
    ]) {
      remember(collaborator.consultantProfile);
    }

    const hostUserIds = [
      ...new Set(
        resolvePlanOwnerIds(appointment)
          .map((profileId) => profileToUser.get(profileId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    ];

    // Attendees are named only for the 1:1 types, where both sides are
    // connected to the slot. A webinar or class can hold hundreds of them and
    // Stream would reject the oversized request, which would turn a working
    // join into a failure — so group events name their hosts and nobody else.
    const isGroupEvent =
      appointment.appointmentType === "WEBINAR" ||
      appointment.appointmentType === "CLASS";
    const hosts = new Set(hostUserIds);
    const guestUserIds = isGroupEvent
      ? []
      : [
          ...new Set(run.slots.flatMap((slot) => slot.user.map((u) => u.id))),
        ].filter((userId) => !hosts.has(userId));

    const offeringTitle =
      appointment.consultation?.consultationPlan?.title ??
      appointment.subscription?.subscriptionPlan?.title ??
      appointment.webinar?.webinarPlan?.title ??
      appointment.class?.classPlan?.title ??
      appointment.trialSession?.subscriptionPlan?.title ??
      null;

    return {
      startsAt: run.startsAt,
      endsAt: run.endsAt,
      durationMinutes: Math.round(
        (run.endsAt.getTime() - run.startsAt.getTime()) / 60_000,
      ),
      offeringTitle,
      members: [
        ...hostUserIds.map((user_id) => ({ user_id, role: HOST_ROLE })),
        ...guestUserIds.map((user_id) => ({ user_id, role: GUEST_ROLE })),
      ],
      hostUserIds,
      guestUserIds,
    };
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to resolve session call profile", error, {
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
