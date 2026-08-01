import * as Sentry from "@sentry/nextjs";
import {
  createDbMeetingSession,
  findDbMeetingSessionBySlot,
  resolveSessionAnchorSlot,
  resolveSessionCallProfile,
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
  // #org-appts — the user ids on each side of the appointment, stamped into the
  // call's custom data so the meeting UI derives host/guest from WHICH SIDE the
  // viewer is on (not the singular UserRole, which is wrong for a dual-profile
  // user booked as a learner into someone else's session). Optional: callers
  // that don't plumb them fall back to the role check.
  consultantUserId?: string | null;
  consulteeUserId?: string | null;
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
    // #1061 — a session longer than 30 minutes is N consecutive slot rows, and
    // each dashboard surface hands us a different one. Key the room to the
    // run's first row so both sides, at any point in the hour, resolve the
    // same call. Server-side because the planner passes a lone slot.
    //
    // The `?? slot` fallback is NOT safe, and is chosen anyway: if the anchor
    // lookup fails for one of two people clicking Join at the same moment,
    // that person mints `slot-<their row>` and leaves a stray MeetingSession
    // on a non-anchor row — exactly the split this change exists to remove.
    // It is still better than the alternative, because the failure is a
    // transient DB error and refusing to join would take the whole meeting
    // down for both sides rather than degrading to today's behaviour for one.
    // Pinned by __tests__/stream/session-room-identity.test.ts.
    const anchorSlot: MeetingSlot =
      (await resolveSessionAnchorSlot(slot.id)) ?? slot;

    // 1. Try to find an existing meeting session via server action
    const existingMeetingSession = await findDbMeetingSessionBySlot(
      anchorSlot.id,
    );

    let streamCallId: string;

    if (existingMeetingSession) {
      // 2a. Found existing session, use its Stream Call ID
      streamCallId = existingMeetingSession.streamCallId;
    } else {
      // 2b. No existing session found, create a new one.
      // Use a deterministic call ID derived from the anchor slot ID so
      // concurrent callers produce the same Stream call. Stream's getOrCreate
      // is idempotent for the same call ID, preventing orphaned calls.
      streamCallId = `slot-${anchorSlot.id}`;

      // 3. Create the Stream call.
      // #1070 — a call created with nothing but an id is illegible in Stream's
      // dashboard and in a recording listing, and leaves every surface to
      // re-infer who is hosting. Resolve the session's real bounds, offering
      // and participants once, server-side. Everything it feeds is additive
      // and every field is individually optional, so a null profile creates
      // exactly the call this code created before.
      const callProfile = await resolveSessionCallProfile(anchorSlot.id);

      const call: Call = client.call("default", streamCallId);
      // The RUN's start, not the clicked row's: joining a 10:00–11:00 session
      // from its 10:30 row must not tell Stream the meeting starts at 10:30.
      const startsAt = (
        callProfile?.startsAt ??
        (anchorSlot.startsAt ? new Date(anchorSlot.startsAt) : new Date())
      ).toISOString();

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

      // #org-appts — per-appointment identity for host/guest derivation. The
      // caller's values win where present; otherwise the server-resolved ones
      // fill them in, which is the first time most surfaces have carried them
      // at all (no caller in the tree populates these today).
      const consultantUserId =
        appointment.consultantUserId ?? callProfile?.hostUserIds[0] ?? null;
      const consulteeUserId =
        appointment.consulteeUserId ?? callProfile?.guestUserIds[0] ?? null;

      const custom: Record<string, unknown> = {
        title: title,
        description: description,
        appointmentId: appointment.id,
        slotId: anchorSlot.id,
        // Named explicitly so a Stream dashboard or recording entry says which
        // row keys the room without anyone having to know `slotId` means the
        // anchor (#1061).
        anchorSlotId: anchorSlot.id,
        appointmentType: appointment.appointmentType,
        ...(resolvedOrgId ? { organizationId: resolvedOrgId } : {}),
        ...(consultantUserId ? { consultantUserId } : {}),
        ...(consulteeUserId ? { consulteeUserId } : {}),
        // #1070 — the session's real shape. `CallRequest` in the installed
        // SDK has no `ends_at`, so the end travels as call metadata; see the
        // note on `settings_override` below for why the one field that could
        // enforce it is not used.
        ...(callProfile
          ? {
              sessionStartsAt: callProfile.startsAt.toISOString(),
              sessionEndsAt: callProfile.endsAt.toISOString(),
              sessionDurationMinutes: callProfile.durationMinutes,
              ...(callProfile.offeringTitle
                ? { offeringTitle: callProfile.offeringTitle }
                : {}),
            }
          : {}),
      };

      await call.getOrCreate({
        data: {
          starts_at: startsAt,
          custom,
          // Records who hosts, once, instead of every surface inferring it.
          // Purely additive: the `default` call type does not restrict entry
          // to members and no setting here enables that, so naming members
          // cannot turn a working join into a refusal.
          //
          // Deliberately NOT sent (deferred to #1070): `backstage`,
          // `join_ahead_time_seconds`, and `settings_override.limits
          // .max_duration_seconds`. The first two let Stream refuse a join, so
          // a consultant who never calls goLive() would strand a paying
          // consultee on a backstage screen — invisible to us, unfixable
          // without a deploy. The third hard-terminates a call that overruns.
          // The join gate stays in our code, where we can see and fix it.
          ...(callProfile && callProfile.members.length > 0
            ? { members: callProfile.members }
            : {}),
        },
      });

      // 4. Create the corresponding record in the database via server action.
      // Attached to the anchor, so MeetingSession.slotOfAppointmentId stays
      // @unique-correct: one session per run, not one per half hour.
      await createDbMeetingSession(anchorSlot, streamCallId);
    }

    // 5. Return the Stream Call ID (either existing or newly created)
    return streamCallId;
  } catch (error) {
    console.error(
      `Error in getOrCreateAppointmentMeeting for slot ${slot.id}:`,
      error,
    );
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    // Wrap the original error
    if (error instanceof Error) {
      throw new Error(`Failed to get/create meeting session: ${error.message}`);
    }
    throw new Error(
      "An unknown error occurred while managing the appointment meeting session.",
    );
  }
};
