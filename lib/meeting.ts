import {
  createDbMeetingSession,
  findDbMeetingSessionBySlot,
} from "@/actions/stream/meetings/meeting.action";
import type { Call } from "@stream-io/video-react-sdk";
import { StreamVideoClient } from "@stream-io/video-react-sdk";
import type { AppointmentsType } from "@prisma/client";

/**
 * Minimal slot interface for meeting operations.
 * This defines only what getOrCreateAppointmentMeeting actually uses.
 * Both TSlotOfAppointment and SlotOfAppointment satisfy this interface.
 */
export interface MeetingSlot {
  id: string;
  startsAt: Date | string;
  endsAt: Date | string | null;
  isTentative?: boolean;
  appointmentId?: string | null;
}

/**
 * Minimal appointment interface for meeting operations.
 * This defines only what getOrCreateAppointmentMeeting actually uses.
 * TAppointment satisfies this interface, as do custom-built objects.
 *
 * `organizationId` (added for #B2 Stream.io org tagging) is optional so
 * callers that don't yet plumb it through still type-check; when set,
 * it's stamped onto the Stream Video call's `custom.organizationId`.
 */
export interface MeetingAppointment {
  id: string;
  appointmentType: AppointmentsType;
  slotsOfAppointment: MeetingSlot[];
  organizationId?: string | null;
  consultation?: {
    requestedBy?: { user?: { name?: string | null } | null } | null;
    consultationPlan?: { title?: string | null } | null;
  } | null;
  subscription?: {
    requestedBy?: { user?: { name?: string | null } | null } | null;
    subscriptionPlan?: { title?: string | null } | null;
  } | null;
  webinar?: {
    webinarPlan?: { title?: string | null } | null;
  } | null;
  class?: {
    classPlan?: { title?: string | null } | null;
  } | null;
}

/**
 * Creates a new meeting (This function might need less usage now)
 * @param client The Stream Video client
 * @param options Meeting options. `organizationId` (optional) stamps the
 *   Stream Video call's `custom.organizationId` for #B2 enterprise tagging
 *   so org workspace operators can later list calls scoped to their org. Omit (or pass
 *   `null`) for personal meetings — the key is left out entirely so older
 *   calls don't accumulate stray null fields.
 * @returns The meeting ID (Stream Call ID)
 */
export const createMeeting = async (
  client: StreamVideoClient,
  options: {
    title: string;
    dateTime?: Date;
    description?: string;
    link?: string;
    organizationId?: string | null;
  },
) => {
  if (!client) {
    throw new Error("Stream client not initialized");
  }

  try {
    const id = crypto.randomUUID();
    const call: Call = client.call("default", id);

    if (!call) {
      throw new Error("Failed to create call");
    }

    const startsAt =
      options.dateTime?.toISOString() ?? new Date(Date.now()).toISOString();
    const description = options.description ?? "Instant Meeting";

    // Build custom payload — only include `organizationId` when set so
    // legacy calls (no org) remain shape-compatible. camelCase here mirrors
    // the existing video-call custom data convention (appointmentId/slotId).
    const custom: Record<string, unknown> = {
      title: options.title,
      description: description,
      link: options.link,
      ...(options.organizationId
        ? { organizationId: options.organizationId }
        : {}),
    };

    await call.getOrCreate({
      data: {
        starts_at: startsAt,
        custom,
      },
    });

    return id;
  } catch (error) {
    console.error("Error creating meeting:", error);
    throw error;
  }
};

/**
 * Gets an existing meeting session ID from the DB or creates a new Stream call
 * and corresponding DB session if one doesn't exist for the appointment slot.
 * Uses server actions for DB operations.
 * @param client The Stream Video client
 * @param appointment The appointment details (any object satisfying MeetingAppointment)
 * @param slot The specific slot of the appointment (any object satisfying MeetingSlot)
 * @param organizationId Optional explicit org override for #B2 Stream.io
 *   tagging. When omitted, falls back to `appointment.organizationId`. Pass
 *   `null` to force-omit the tag. Only applied on first creation — existing
 *   Stream calls keep their original custom data (Stream's getOrCreate is
 *   idempotent on the call ID, so re-calling won't rewrite custom fields).
 * @returns The Stream Call ID for the meeting
 */
export const getOrCreateAppointmentMeeting = async (
  client: StreamVideoClient,
  appointment: MeetingAppointment,
  slot: MeetingSlot,
  organizationId?: string | null,
): Promise<string> => {
  if (!client) {
    throw new Error("Stream client not initialized");
  }
  if (!appointment || !slot) {
    throw new Error("Appointment or Slot data is missing.");
  }

  try {
    // 1. Try to find an existing meeting session via server action
    const existingMeetingSession = await findDbMeetingSessionBySlot(slot.id);

    let streamCallId: string;

    if (existingMeetingSession) {
      // 2a. Found existing session, use its Stream Call ID
      streamCallId = existingMeetingSession.streamCallId;
    } else {
      // 2b. No existing session found, create a new one.
      // Use a deterministic call ID derived from the slot ID so concurrent
      // callers produce the same Stream call. Stream's getOrCreate is
      // idempotent for the same call ID, preventing orphaned calls.
      streamCallId = `slot-${slot.id}`;

      // 3. Create the Stream call
      const call: Call = client.call("default", streamCallId);
      const startsAt = slot.startsAt
        ? new Date(slot.startsAt).toISOString()
        : new Date().toISOString();

      // Determine title and description based on appointment type
      let title = `Meeting for Appointment ${appointment.id}`;
      let description = `${appointment.appointmentType} Meeting`;

      if (appointment.consultation?.requestedBy?.user?.name) {
        title = `${appointment.appointmentType} with ${appointment.consultation.requestedBy.user.name}`;
      } else if (appointment.subscription?.requestedBy?.user?.name) {
        title = `${appointment.appointmentType} with ${appointment.subscription.requestedBy.user.name}`;
      } else if (appointment.webinar?.webinarPlan?.title) {
        title = `Webinar: ${appointment.webinar.webinarPlan.title}`;
        description = `Webinar Session for ${appointment.webinar.webinarPlan.title}`;
      } else if (appointment.class?.classPlan?.title) {
        title = `Class: ${appointment.class.classPlan.title}`;
        description = `Class Session for ${appointment.class.classPlan.title}`;
      }

      // #B2 Stream.io org tagging — prefer explicit param over the
      // appointment's stored org. `null` from caller force-omits.
      const resolvedOrgId =
        organizationId === undefined
          ? appointment.organizationId ?? null
          : organizationId;

      const custom: Record<string, unknown> = {
        title: title,
        description: description,
        appointmentId: appointment.id,
        slotId: slot.id,
        appointmentType: appointment.appointmentType,
        ...(resolvedOrgId ? { organizationId: resolvedOrgId } : {}),
      };

      await call.getOrCreate({
        data: {
          starts_at: startsAt,
          custom,
        },
      });

      // 4. Create the corresponding record in the database via server action
      await createDbMeetingSession(slot, streamCallId);
    }

    // 5. Return the Stream Call ID (either existing or newly created)
    return streamCallId;
  } catch (error) {
    console.error(
      `Error in getOrCreateAppointmentMeeting for slot ${slot.id}:`,
      error,
    );
    // Wrap the original error
    if (error instanceof Error) {
      throw new Error(`Failed to get/create meeting session: ${error.message}`);
    }
    throw new Error(
      "An unknown error occurred while managing the appointment meeting session.",
    );
  }
};
