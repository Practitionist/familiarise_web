import { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { isPresenterRole } from "@/lib/collaborators/roles";
import { checkConsent } from "@/lib/compliance/dpdp";
import { PURPOSE_CODES } from "@/lib/compliance/purpose-codes";
import {
  getStreamVideoClient,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import {
  parseOccurrenceIdFromCallId,
  STREAM_CALL_TYPE,
  toCallId,
} from "@/lib/stream/call-cid";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  CONSULTANT_JOIN_WINDOW_MS,
  REJOIN_GRACE_MS,
  getOccurrenceJoinState,
  isDeadOccurrence,
  isDeliberateEnd,
  type JoinableOccurrence,
} from "@/lib/appointments/occurrences";
import {
  isCancelledLikeStatus,
  isCompletedLikeStatus,
  isConfirmedStatus,
} from "@/lib/appointments/status";

/** Server-side meeting access role granted to an authorized caller. */
export type MeetingRole = "host" | "participant" | null;

/** Machine-readable access verdict used by API routes to select HTTP status codes. */
export type MeetingAccessReason = "granted" | "not_found" | "unauthorized";

interface MeetingNotFound {
  hasAccess: false;
  role: null;
  message: string;
  reason: "not_found";
}

interface MeetingResolved {
  hasAccess: boolean;
  role: MeetingRole;
  message: string;
  reason: "granted" | "unauthorized";
  code?: "CONSENT_REQUIRED" | "TOO_EARLY" | "SESSION_ENDED";
  startsAt?: string | null;
  endsAt?: string | null;
  canReopen?: boolean;
  /** An accepted presenter collaborator on a webinar or class plan, not the plan owner. */
  coPresenter?: boolean;
  streamCallId: string;
  meetingId: string;
  appointment: MeetingAppointment;
  occurrence?: ResolvedMeeting["occurrence"];
}

export type MeetingAccess = MeetingNotFound | MeetingResolved;

type ResolvedMeeting = NonNullable<Awaited<ReturnType<typeof loadMeeting>>>;
export type MeetingAppointment = ResolvedMeeting["occurrence"]["appointment"];

const MEETING_SESSION_INCLUDE = {
  occurrence: {
    include: {
      appointment: {
        include: {
          consultation: {
            include: {
              consultationPlan: {
                select: {
                  title: true,
                  organizationId: true,
                  consultantProfileId: true,
                  recordingEnabled: true,
                  consultantProfile: { select: { userId: true } },
                },
              },
            },
          },
          subscription: {
            include: {
              subscriptionPlan: {
                select: {
                  title: true,
                  organizationId: true,
                  consultantProfileId: true,
                  recordingEnabled: true,
                  consultantProfile: { select: { userId: true } },
                },
              },
            },
          },
          webinar: {
            include: {
              webinarPlan: {
                select: {
                  id: true,
                  title: true,
                  organizationId: true,
                  consultantProfileId: true,
                  recordingEnabled: true,
                  consultantProfile: { select: { userId: true } },
                },
              },
            },
          },
          class: {
            include: {
              classPlan: {
                select: {
                  id: true,
                  title: true,
                  organizationId: true,
                  consultantProfileId: true,
                  recordingEnabled: true,
                  consultantProfile: { select: { userId: true } },
                },
              },
            },
          },
          trial: {
            select: {
              consultantProfileId: true,
              status: true,
              subscriptionPlan: {
                select: {
                  title: true,
                  organizationId: true,
                  consultantProfileId: true,
                  recordingEnabled: true,
                  consultantProfile: { select: { userId: true } },
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.MeetingInclude;

async function loadMeeting(callId: string) {
  const direct = await prisma.meeting.findUnique({
    where: { streamCallId: callId },
    include: MEETING_SESSION_INCLUDE,
  });
  if (direct) return direct;

  const occurrenceId = parseOccurrenceIdFromCallId(callId);
  if (!occurrenceId) return null;

  return prisma.meeting.findUnique({
    where: { appointmentOccurrenceId: occurrenceId },
    include: MEETING_SESSION_INCLUDE,
  });
}

/** Verifies whether the user holds active DPDP consent for Stream video/chat processing. */
export async function hasStreamConsent(userId: string): Promise<boolean> {
  return checkConsent({
    userId,
    purposeCode: PURPOSE_CODES.STREAM_DATA_PROCESSING,
  });
}

function bookingStatusRefusal(status: string | null): string | null {
  if (!status) return null;
  if (isConfirmedStatus(status) || isCompletedLikeStatus(status)) return null;
  return isCancelledLikeStatus(status)
    ? "This booking is no longer active."
    : "This session is not confirmed yet.";
}

export type GatedOccurrence = JoinableOccurrence & {
  meeting: { id: string; endedAt: Date | null; endedReason: string | null };
};

/** Evaluates time-window, deliberate-end, and live-room rejoin rules for an occurrence. */
export async function meetingPolicyRefusal(args: {
  occurrence: GatedOccurrence;
  role: Exclude<MeetingRole, null>;
  streamCallId: string;
}): Promise<{ message: string; code?: "TOO_EARLY" | "SESSION_ENDED" } | null> {
  const now = new Date();
  const { occurrence } = args;
  if (isDeadOccurrence(occurrence)) {
    return { message: "This session has no active time slot." };
  }

  const state = getOccurrenceJoinState(occurrence, {
    joinWindowMs:
      args.role === "host"
        ? CONSULTANT_JOIN_WINDOW_MS
        : CONSULTEE_JOIN_WINDOW_MS,
    rejoinGraceMs: 0,
    now,
  });

  switch (state) {
    case "disabled":
      return {
        message: occurrence.isTentative
          ? "This session is not confirmed yet."
          : "This session is no longer available.",
      };
    case "countdown":
      return {
        message: `Join opens ${
          (args.role === "host"
            ? CONSULTANT_JOIN_WINDOW_MS
            : CONSULTEE_JOIN_WINDOW_MS) / 60000
        } minutes before the start time.`,
        code: "TOO_EARLY",
      };
    case "ended": {
      if (isDeliberateEnd(occurrence.meeting)) {
        return { message: "This session has ended.", code: "SESSION_ENDED" };
      }

      if (
        occurrence.endsAt &&
        now.getTime() <= new Date(occurrence.endsAt).getTime() + REJOIN_GRACE_MS
      )
        return null;

      if (await callHasLiveParticipants(args.streamCallId)) return null;

      return { message: "This session has ended.", code: "SESSION_ENDED" };
    }
    default:
      return null;
  }
}

/** Checks Stream for active participants when evaluating rejoin requests past the grace window. */
async function callHasLiveParticipants(streamCallId: string): Promise<boolean> {
  if (!isStreamConfigured()) return false;
  try {
    const { call: state } = await withStreamCircuitBreaker(() =>
      getStreamVideoClient()
        .video.call(STREAM_CALL_TYPE, toCallId(streamCallId))
        .get(),
    );
    if (state.ended_at) return false;
    return (state.session?.participants?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function resolveMeetingAccess(
  callId: string,
  userId: string,
): Promise<MeetingAccess> {
  const meeting = await loadMeeting(callId);

  if (!meeting) {
    return {
      hasAccess: false,
      role: null,
      message: "Meeting not found",
      reason: "not_found",
    };
  }

  const streamCallId = meeting.streamCallId;
  const meetingId = meeting.id;
  const appointment = meeting.occurrence.appointment;

  const userProfile = await prisma.user.findUnique({
    where: { id: userId },
    select: { consultantProfileId: true },
  });

  const seat = await prisma.appointmentParticipant.findFirst({
    where: { appointmentId: appointment.id, ...liveParticipant(userId) },
    select: { id: true },
  });
  const isParticipant = seat !== null;

  const consultantProfileId =
    appointment.consultation?.consultationPlan?.consultantProfileId ??
    appointment.subscription?.subscriptionPlan?.consultantProfileId ??
    appointment.webinar?.webinarPlan?.consultantProfileId ??
    appointment.class?.classPlan?.consultantProfileId ??
    appointment.trial?.consultantProfileId ??
    null;
  const occurrenceConsultantProfileId =
    meeting.occurrence.consultantProfileId ?? null;

  const grant = async (
    role: Exclude<MeetingRole, null>,
    message: string,
    coPresenter = false,
  ): Promise<MeetingAccess> => {
    const bookingStatus =
      appointment.consultation?.status ??
      appointment.subscription?.status ??
      appointment.webinar?.status ??
      appointment.class?.status ??
      appointment.trial?.status ??
      null;
    const statusRefusal = bookingStatusRefusal(bookingStatus);
    if (statusRefusal || appointment.deletedAt) {
      return {
        hasAccess: false,
        role: null,
        message: statusRefusal ?? "This booking is no longer active.",
        reason: "unauthorized",
        streamCallId,
        meetingId,
        appointment,
        occurrence: meeting.occurrence,
      };
    }
    if (!(await hasStreamConsent(userId))) {
      return {
        hasAccess: false,
        role: null,
        message:
          "Consent for live video processing is required to join this session.",
        reason: "unauthorized",
        code: "CONSENT_REQUIRED",
        streamCallId,
        meetingId,
        appointment,
        occurrence: meeting.occurrence,
      };
    }
    const refusal = await meetingPolicyRefusal({
      occurrence: {
        ...meeting.occurrence,
        meeting: {
          id: meeting.id,
          endedAt: meeting.endedAt,
          endedReason: meeting.endedReason,
        },
      },
      role,
      streamCallId,
    });
    if (refusal) {
      const occStart = new Date(meeting.occurrence.startsAt);
      const occEnd = meeting.occurrence.endsAt
        ? new Date(meeting.occurrence.endsAt)
        : new Date(occStart.getTime() + 60 * 60 * 1000);
      const canReopen =
        role === "host" &&
        refusal.code === "SESSION_ENDED" &&
        isDeliberateEnd({
          endedAt: meeting.endedAt,
          endedReason: meeting.endedReason,
        }) &&
        !isDeadOccurrence(meeting.occurrence) &&
        Date.now() <= occEnd.getTime() + REJOIN_GRACE_MS;

      return {
        hasAccess: false,
        role: null,
        message: refusal.message,
        reason: "unauthorized",
        ...(refusal.code ? { code: refusal.code } : {}),
        startsAt: occStart.toISOString(),
        endsAt: occEnd.toISOString(),
        canReopen,
        streamCallId,
        meetingId,
        appointment,
        occurrence: meeting.occurrence,
      };
    }
    return {
      hasAccess: true,
      role,
      message,
      reason: "granted",
      ...(coPresenter ? { coPresenter } : {}),
      streamCallId,
      meetingId,
      appointment,
      occurrence: meeting.occurrence,
    };
  };

  if (
    (consultantProfileId &&
      userProfile?.consultantProfileId === consultantProfileId) ||
    (occurrenceConsultantProfileId &&
      userProfile?.consultantProfileId === occurrenceConsultantProfileId)
  ) {
    return grant("host", "Access granted as meeting host");
  }

  if (userProfile?.consultantProfileId) {
    const webinarPlanId = appointment.webinar?.webinarPlan?.id;
    const classPlanId = appointment.class?.classPlan?.id;

    if (webinarPlanId || classPlanId) {
      const collab = await prisma.collaborator.findFirst({
        where: {
          consultantProfileId: userProfile.consultantProfileId,
          status: "ACCEPTED",
          consultantProfile: { deletedAt: null },
          ...(webinarPlanId ? { webinarPlanId } : { classPlanId }),
        },
        select: { id: true, role: true },
      });
      if (collab) {
        return isPresenterRole(collab.role)
          ? grant("host", "Access granted as accepted co-presenter", true)
          : grant("participant", "Access granted as accepted collaborator");
      }
    }
  }

  if (isParticipant) {
    return grant("participant", "Access granted as participant");
  }

  return {
    hasAccess: false,
    role: null,
    message: "You are not authorized to join this meeting",
    reason: "unauthorized",
    streamCallId,
    meetingId,
    appointment,
    occurrence: meeting.occurrence,
  };
}
