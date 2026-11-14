"use server";

import { settleLapsedProposalForOccurrence } from "@/lib/booking/reschedule-lapse";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { isDeadOccurrence } from "@/lib/appointments/occurrences";
import {
  isCompletedLikeStatus,
  isConfirmedStatus,
} from "@/lib/appointments/status";
import {
  buildRoomCallPlan,
  readSlotForCaller,
  resolveAppointmentOrgId,
  slotIdSchema,
  STREAM_SERVER_TRUSTED,
} from "@/lib/meetings/call-provisioning";
import {
  endBlocksRejoin,
  type MeetingEndReason,
} from "@/lib/meetings/end-reasons";
import { getMaintenanceState } from "@/lib/maintenance";
import { Meeting } from "@prisma/client";
import { upsertUsersToStream } from "@/actions/stream/chat/user.action";
import { streamLogger } from "@/lib/stream-logger";
import {
  getStreamVideoClient,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE } from "@/lib/stream/call-cid";
import { assertValidGetOrCreateCall } from "@/lib/stream/video-contracts";
import {
  fenceSeatGrants,
  releaseUnsavedRoom,
} from "@/lib/stream/access-revocation";

interface MeetingSlot {
  id: string;
  startsAt?: Date | string;
  endsAt?: Date | string | null;
  isTentative?: boolean;
  appointmentId?: string | null;
}

const streamCallIdSchema = z.string().min(1, "Stream Call ID is required");

/** Stamped when the host closes a room before the scheduled slot ends. */
const ENDED_EARLY_REASON: MeetingEndReason = "ended_early";

class MeetingRefusal extends Error {}

async function requireEntitledCaller(slotId: string) {
  const authorized = await readSlotForCaller(slotId);
  if (!authorized) {
    throw new MeetingRefusal("You are not a participant in this session.");
  }
  return authorized;
}

const slotSchema = z.object({
  id: z.string().min(1),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  isTentative: z.boolean().optional(),
  appointmentId: z.string().nullable().optional(),
});

async function findDbMeetingBySlot(slotId: string): Promise<Meeting | null> {
  const validatedSlotId = slotIdSchema.parse(slotId);

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { appointmentOccurrenceId: validatedSlotId },
    });

    if (meeting) {
      streamLogger.debug("Found existing meeting session", {
        sessionId: meeting.id,
        slotId: validatedSlotId,
      });
    } else {
      streamLogger.debug("No existing meeting session found", {
        slotId: validatedSlotId,
      });
    }

    return meeting;
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Error finding meeting session", error, {
      slotId: validatedSlotId,
    });
    return null;
  }
}

async function refuseDuringMaintenance(): Promise<string | null> {
  const maintenanceState = await getMaintenanceState();
  return maintenanceState.phase === "OFF"
    ? null
    : "New calls cannot be created during maintenance.";
}

async function refuseMeetingCreation(
  slot: MeetingSlot,
): Promise<string | null> {
  const parsedSlot = slotSchema.safeParse({
    id: slot.id,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    isTentative: slot.isTentative,
    appointmentId: slot.appointmentId,
  });
  if (!parsedSlot.success) {
    return `Invalid slot for meeting session: ${parsedSlot.error.issues
      .map((issue) => `${issue.path.join(".") || "value"} ${issue.message}`)
      .join("; ")}`;
  }

  const dbSlot = await prisma.appointmentOccurrence.findUnique({
    where: { id: parsedSlot.data.id },
    select: {
      startsAt: true,
      endsAt: true,
      isTentative: true,
      completionStatus: true,
      deletedAt: true,
      meeting: {
        select: { id: true, endedAt: true, endedReason: true },
      },
      appointment: {
        select: {
          deletedAt: true,
          consultation: { select: { status: true } },
          subscription: { select: { status: true } },
          webinar: { select: { status: true } },
          class: { select: { status: true } },
          trial: { select: { status: true } },
        },
      },
    },
  });
  if (!dbSlot) {
    return "Session slot not found.";
  }
  if (dbSlot.isTentative) {
    return "This session is not confirmed yet.";
  }
  if (isDeadOccurrence(dbSlot)) {
    return "This session was cancelled or moved.";
  }
  if (endBlocksRejoin(dbSlot.meeting)) {
    return "This session has already ended.";
  }
  const appt = dbSlot.appointment;
  if (appt) {
    if (appt.deletedAt) {
      return "This booking is no longer active.";
    }
    const bookingStatus =
      appt.consultation?.status ??
      appt.subscription?.status ??
      appt.webinar?.status ??
      appt.class?.status ??
      appt.trial?.status ??
      null;
    if (bookingStatus && TERMINAL_APPOINTMENT_STATUSES.has(bookingStatus)) {
      return "This booking is no longer active.";
    }
    if (
      bookingStatus &&
      !isConfirmedStatus(bookingStatus) &&
      !isCompletedLikeStatus(bookingStatus)
    ) {
      return "This booking is not confirmed yet.";
    }
  }

  return null;
}

const TERMINAL_APPOINTMENT_STATUSES = new Set([
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
  "CONVERTED",
]);

async function getMeetingCreationRefusal(
  slot: MeetingSlot,
  existingRoom: boolean,
): Promise<string | null> {
  try {
    // Maintenance blocks new rooms only, so a session in progress keeps its room.
    const refusal =
      (existingRoom ? null : await refuseDuringMaintenance()) ??
      (await refuseMeetingCreation(slot));
    if (refusal) {
      streamLogger.warn("Refused a meeting before creating the call", {
        slotId: slot.id,
        reason: refusal,
      });
    }
    return refusal;
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to pre-check meeting creation", error, {
      slotId: slot.id,
    });
    return "We could not verify this session just now. Please try again.";
  }
}

async function readAppointmentOrganizationId(
  appointmentId: string | null | undefined,
): Promise<string | null> {
  if (!appointmentId) return null;
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      organizationId: true,
      consultation: {
        select: { consultationPlan: { select: { organizationId: true } } },
      },
      subscription: {
        select: { subscriptionPlan: { select: { organizationId: true } } },
      },
      webinar: {
        select: { webinarPlan: { select: { organizationId: true } } },
      },
      class: {
        select: { classPlan: { select: { organizationId: true } } },
      },
      trial: {
        select: { subscriptionPlan: { select: { organizationId: true } } },
      },
    },
  });
  return resolveAppointmentOrgId(appointment);
}

/** Persists the Meeting row for an occurrence after verifying caller entitlement and booking state. */
async function createDbMeeting(
  slot: MeetingSlot,
  streamCallId: string,
): Promise<Meeting> {
  try {
    const authorized = await requireEntitledCaller(slot.id);

    const refusal =
      (await refuseDuringMaintenance()) ?? (await refuseMeetingCreation(slot));
    if (refusal) throw new MeetingRefusal(refusal);

    const validatedStreamCallId = streamCallIdSchema.parse(streamCallId);

    streamLogger.debug("Creating meeting session", {
      slotId: slot.id,
      streamCallId: validatedStreamCallId,
    });

    const organizationId =
      resolveAppointmentOrgId(authorized.appointment) ??
      (await readAppointmentOrganizationId(authorized.slot.appointmentId));

    const meeting = await prisma.meeting.create({
      data: {
        streamCallId: validatedStreamCallId,
        platform: "STREAM",
        occurrence: {
          connect: { id: slot.id },
        },
        ...(organizationId
          ? { organization: { connect: { id: organizationId } } }
          : {}),
      },
    });

    streamLogger.info("Meeting session created", {
      sessionId: meeting.id,
      slotId: slot.id,
      streamCallId: validatedStreamCallId,
    });

    return meeting;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      streamLogger.info(
        "Meeting session already exists (concurrent creation), returning existing",
        { slotId: slot.id },
      );
      const existing = await prisma.meeting.findUnique({
        where: { appointmentOccurrenceId: slot.id },
      });
      if (existing) return existing;
    }

    if (error instanceof MeetingRefusal) {
      streamLogger.warn("Refused to create meeting session", {
        slotId: slot.id,
        streamCallId,
        reason: error.message,
      });
      throw new Error(error.message);
    }

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to create meeting session", error, {
      slotId: slot.id,
      streamCallId,
    });

    if (error instanceof Error) {
      throw new Error(`Failed to create meeting session: ${error.message}`);
    }
    throw new Error(
      "An unknown error occurred while creating the meeting session.",
    );
  }
}

export type ProvisionedMeeting =
  { ok: true; streamCallId: string } | { ok: false; refusal: string };

/** Provisions or reuses the Stream call and database Meeting row for an occurrence. */
export async function provisionAppointmentMeeting(
  slot: MeetingSlot,
): Promise<ProvisionedMeeting> {
  const granted: RoomGrant = { appointmentId: null, userIds: [] };
  const result = await provisionRoom(slot, granted);
  // The room is created with its seat holders as members; a cancel that committed meanwhile found no room to clear.
  if (result.ok && granted.appointmentId) {
    await fenceSeatGrants(granted.appointmentId, granted.userIds);
  }
  return result;
}

/** Who the room's create payload made a member, under the caller's authorized appointment. */
interface RoomGrant {
  appointmentId: string | null;
  userIds: string[];
}

/** A reused row keeps its call id; an early-ended row is rebuilt under a fresh one. */
function resolveStreamCallId(
  slotId: string,
  existingMeeting: { streamCallId: string } | null | undefined,
  rebuildEndedEarly: boolean,
): string {
  if (rebuildEndedEarly) {
    return `occurrence-${slotId}-r${Date.now().toString(36)}`;
  }
  return existingMeeting?.streamCallId ?? `occurrence-${slotId}`;
}

async function provisionRoom(
  slot: MeetingSlot,
  granted: RoomGrant,
): Promise<ProvisionedMeeting> {
  const anchorSlot: MeetingSlot = slot;

  const existingMeeting = await findDbMeetingBySlot(anchorSlot.id);
  const rebuildEndedEarly = existingMeeting?.endedReason === ENDED_EARLY_REASON;
  // An existing row re-asserts its call below, so a row whose call is missing heals here.
  const reuseExisting = !!existingMeeting && !rebuildEndedEarly;

  const authorized = await readSlotForCaller(anchorSlot.id);
  if (!authorized) {
    return { ok: false, refusal: "You are not a participant in this session." };
  }
  // A move past its deadline is ended first, so the original session opens.
  await settleLapsedProposalForOccurrence(anchorSlot.id);

  const refusal = await getMeetingCreationRefusal(anchorSlot, reuseExisting);
  if (refusal) return { ok: false, refusal };

  if (!isStreamConfigured()) {
    streamLogger.error("Stream not configured — cannot provision meeting", {
      slotId: anchorSlot.id,
    });
    return { ok: false, refusal: "Video is not available right now." };
  }

  const streamCallId = resolveStreamCallId(
    anchorSlot.id,
    existingMeeting,
    rebuildEndedEarly,
  );
  const { authorUserId, payload } = await buildRoomCallPlan(authorized, {
    extendedSeconds: existingMeeting?.extendedSeconds ?? 0,
    extensionsUsed: existingMeeting?.extensionsUsed ?? 0,
  });
  const resolvedAppointmentId = authorized.slot.appointmentId;
  granted.appointmentId = resolvedAppointmentId ?? null;
  granted.userIds = payload.data.members?.map((m) => m.user_id) ?? [];

  try {
    await upsertUsersToStream([authorUserId], {
      serverTrusted: STREAM_SERVER_TRUSTED,
    });
    assertValidGetOrCreateCall(payload);
    await withStreamCircuitBreaker(() =>
      getStreamVideoClient()
        .video.call(STREAM_CALL_TYPE, streamCallId)
        .getOrCreate(payload),
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to create the Stream call", error, {
      slotId: anchorSlot.id,
      streamCallId,
    });
    throw error instanceof Error
      ? new Error(`Failed to create meeting session: ${error.message}`, {
          cause: error,
        })
      : new Error("Failed to create meeting session.", { cause: error });
  }

  if (reuseExisting) return { ok: true, streamCallId };

  if (rebuildEndedEarly && existingMeeting) {
    const rebound = await prisma.meeting.updateMany({
      where: { id: existingMeeting.id, endedReason: ENDED_EARLY_REASON },
      data: {
        streamCallId,
        endedAt: null,
        endedReason: null,
        isRecording: false,
      },
    });
    if (rebound.count === 0) {
      const current = await prisma.meeting.findUnique({
        where: { id: existingMeeting.id },
        select: { streamCallId: true },
      });
      return {
        ok: true,
        streamCallId: current?.streamCallId ?? streamCallId,
      };
    }
    streamLogger.info("Rebuilt the room after an early end", {
      sessionId: existingMeeting.id,
      slotId: anchorSlot.id,
      previousStreamCallId: existingMeeting.streamCallId,
      streamCallId,
    });
    return { ok: true, streamCallId };
  }

  try {
    await createDbMeeting(
      { ...anchorSlot, appointmentId: resolvedAppointmentId },
      streamCallId,
    );
  } catch (error) {
    // No Meeting row means no revocation can find this call, so its new members leave it.
    await releaseUnsavedRoom(streamCallId, granted.userIds);
    throw error;
  }

  return { ok: true, streamCallId };
}
