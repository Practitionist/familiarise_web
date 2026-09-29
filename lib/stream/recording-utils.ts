/**
 * Recording Utility Functions
 * Shared helpers for recording-related operations
 */

import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { isPresenterRole } from "@/lib/collaborators/roles";
import type { CollaboratorRole } from "@prisma/client";

/**
 * Type for appointment with ownership relations
 * Used for checking if a consultant owns a recording/session
 */
export interface OwnedPlan {
  consultantProfileId: string | null;
  recordingEnabled?: boolean;
  /** ACCEPTED rows only, when the caller selected them (#1580 C-P1-4). */
  collaborators?: { consultantProfileId: string; role: CollaboratorRole }[];
}

export interface AppointmentWithOwnership {
  webinar?: { webinarPlan?: OwnedPlan | null } | null;
  class?: { classPlan?: OwnedPlan | null } | null;
  // #1134 P1-6 — 1:1 was simply absent here, which is why recording a
  // consultation or a subscription was impossible rather than merely disabled:
  // isAppointmentOwner returned false for the actual owner, so start-recording
  // 403'd, and isRecordingEnabledForAppointment reported false regardless of
  // what the plan said.
  consultation?: { consultationPlan?: OwnedPlan | null } | null;
  subscription?: { subscriptionPlan?: OwnedPlan | null } | null;
}

/**
 * The plan behind an appointment, whichever of the four kinds it is.
 * One resolver so ownership and the recording flag can never disagree about
 * which plan they are reading — the bug above was exactly that divergence.
 */
export function resolveAppointmentPlan(
  appointment: AppointmentWithOwnership | null | undefined,
): OwnedPlan | null {
  if (!appointment) return null;
  return (
    appointment.webinar?.webinarPlan ??
    appointment.class?.classPlan ??
    appointment.consultation?.consultationPlan ??
    appointment.subscription?.subscriptionPlan ??
    null
  );
}

/**
 * Check if a consultant may act as the appointment's host: the plan owner,
 * or an ACCEPTED co-presenter on a webinar/class plan (#1580 C-P1-4). Crew
 * roles are members of the call but never hold the recording controls.
 *
 * @param appointment - The appointment with webinar/class plan relations
 * @param consultantProfileId - The consultant's profile ID to check against
 * @returns true if the consultant owns or co-presents the appointment
 */
export function isAppointmentOwner(
  appointment: AppointmentWithOwnership | null | undefined,
  consultantProfileId: string | null | undefined,
): boolean {
  if (!consultantProfileId) return false;
  const plan = resolveAppointmentPlan(appointment);
  if (!plan) return false;
  if (plan.consultantProfileId === consultantProfileId) return true;
  return (plan.collaborators ?? []).some(
    (c) =>
      c.consultantProfileId === consultantProfileId && isPresenterRole(c.role),
  );
}

/**
 * Check if recording is enabled for an appointment
 *
 * @param appointment - The appointment with webinar/class plan relations
 * @returns true if recording is enabled for this appointment's plan
 */
export function isRecordingEnabledForAppointment(
  appointment: AppointmentWithOwnership | null | undefined,
): boolean {
  return resolveAppointmentPlan(appointment)?.recordingEnabled === true;
}

/**
 * Get ownership info from a recording with nested relations
 *
 * @param recording - Recording with meeting -> occurrence -> appointment relations
 * @param consultantProfileId - The consultant's profile ID to check against
 * @returns Object with isOwner and recordingEnabled flags
 */
export function getRecordingOwnershipInfo(
  recording: {
    meeting?: {
      occurrence?: {
        appointment?: AppointmentWithOwnership | null;
      } | null;
    } | null;
  } | null,
  consultantProfileId: string | null | undefined,
): { isOwner: boolean; recordingEnabled: boolean } {
  const appointment = recording?.meeting?.occurrence?.appointment;

  return {
    isOwner: isAppointmentOwner(appointment, consultantProfileId),
    recordingEnabled: isRecordingEnabledForAppointment(appointment),
  };
}

/**
 * Get ownership info from a meeting session with nested relations
 *
 * @param meeting - Meeting with occurrence -> appointment relations
 * @param consultantProfileId - The consultant's profile ID to check against
 * @returns Object with isOwner and recordingEnabled flags
 */
/**
 * Appointment shape for title generation (includes plan titles for all event types)
 */
interface AppointmentWithTitles {
  webinar?: { webinarPlan?: { title?: string } | null } | null;
  class?: { classPlan?: { title?: string } | null } | null;
  consultation?: { consultationPlan?: { title?: string } | null } | null;
  subscription?: { subscriptionPlan?: { title?: string } | null } | null;
}

/**
 * Generate a recording title from appointment info and date.
 * Shared across recording handlers and sync functions to avoid duplication.
 */
export function generateRecordingTitle(
  appointment: AppointmentWithTitles | null | undefined,
  recordedAt: Date,
): string {
  let title = "Recording";

  if (appointment?.webinar?.webinarPlan?.title) {
    title = `Webinar: ${appointment.webinar.webinarPlan.title}`;
  } else if (appointment?.class?.classPlan?.title) {
    title = `Class: ${appointment.class.classPlan.title}`;
  } else if (appointment?.consultation?.consultationPlan?.title) {
    title = `Consultation: ${appointment.consultation.consultationPlan.title}`;
  } else if (appointment?.subscription?.subscriptionPlan?.title) {
    title = `Subscription: ${appointment.subscription.subscriptionPlan.title}`;
  }

  const dateStr = recordedAt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return `${title} - ${dateStr}`;
}

/**
 * How long Stream keeps a recording's bytes and serves its URL.
 *
 * Two clocks, and they do not start together. The app-level
 * `cdn_expiration_seconds` on the live Stream app is 1209600 — fourteen days
 * measured from WHEN THE URL WAS MINTED. The retention on the object itself is
 * fourteen days from the CALL. For the webhook path (the URL is written a
 * minute or two after the call ends) those agree to within minutes, which is
 * why the difference stayed invisible. For a row recovered late by the orphan
 * reconciler they are up to fourteen days apart, and measuring from `now()`
 * hands the user an expiry date at which the bytes stopped existing days
 * earlier.
 */
export const STREAM_RECORDING_RETENTION_DAYS = 14;

/**
 * When a recording's Stream URL really stops working: the EARLIER of
 * "call time + retention" and "now + retention", because whichever runs out
 * first is the moment the object is gone.
 *
 * `recordedAt` is the call's start (Stream's own `call_recording.start_time`,
 * which both the webhook writer and the sync path persist), so it is the anchor
 * the retention window is actually measured from. Clamping to `now + retention`
 * keeps the function correct for the webhook path too: a row written a minute
 * after the call gets a deadline a minute earlier than a naive `recordedAt + 14d`
 * would give, which is the honest reading of a CDN expiry that is already ticking.
 *
 * Computed in UTC. The previous implementation used local `setDate`, so the same
 * recording expired on a different calendar day depending on which timezone the
 * Lambda happened to run in — and a day-31 boundary shifts the month.
 */
export function streamUrlExpiresAt(
  recordedAt: Date,
  now: Date = new Date(),
): Date {
  const addDays = (base: Date, days: number) => {
    const out = new Date(base.getTime());
    out.setUTCDate(out.getUTCDate() + days);
    return out;
  };
  const fromCall = addDays(recordedAt, STREAM_RECORDING_RETENTION_DAYS);
  const fromNow = addDays(now, STREAM_RECORDING_RETENTION_DAYS);
  return fromCall < fromNow ? fromCall : fromNow;
}

/**
 * Every live seat holder of the meeting's booking (#1554): the event's whole
 * roster for a webinar or class, the two sides for a 1:1.
 */
export async function getEventAttendeeIds(
  appointment:
    | {
        id: string;
        webinar?: { id: string } | null;
        class?: { id: string } | null;
      }
    | null
    | undefined,
): Promise<string[]> {
  if (!appointment) return [];

  const scope = appointment.webinar
    ? { appointment: { webinarId: appointment.webinar.id } }
    : appointment.class
      ? { appointment: { classId: appointment.class.id } }
      : { appointmentId: appointment.id };

  const seats = await prisma.appointmentParticipant.findMany({
    where: { ...scope, ...liveParticipant() },
    select: { userId: true },
  });

  return Array.from(new Set(seats.map((seat) => seat.userId)));
}

export function getMeetingOwnershipInfo(
  meeting: {
    occurrence?: {
      appointment?: AppointmentWithOwnership | null;
    } | null;
  } | null,
  consultantProfileId: string | null | undefined,
): { isOwner: boolean; recordingEnabled: boolean } {
  const appointment = meeting?.occurrence?.appointment;

  return {
    isOwner: isAppointmentOwner(appointment, consultantProfileId),
    recordingEnabled: isRecordingEnabledForAppointment(appointment),
  };
}
