import { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";

/**
 * #1134 P0-1 — the single definition of "may this user join this meeting".
 *
 * It used to live inline in the validate-access route, which was the ONLY gate
 * on a video call: the meeting page rendered "Access Denied" from a React
 * conditional while the Stream token authorized every call in the app, so
 * `client.call(type, id).join()` from devtools walked straight into a private
 * consultation. `POST /api/meetings/[meetingId]/join` now shares this function
 * and grants Stream call membership only when it says yes — so with `join-call`
 * moved off the `user` role, this answer is what Stream itself enforces, not
 * just what the UI draws. `validate-access` shares it too, as a read-only probe,
 * so the gate and the affordance can never give different answers.
 */
export type MeetingRole = "host" | "participant" | null;

/**
 * Why access was granted or refused, as a stable value.
 *
 * Callers need this to pick an HTTP status, and both of them used to do it by
 * comparing `message` to the literal `"Meeting not found"`. Rewording a
 * user-facing string would have silently turned a 404 into a 403 in two routes
 * at once — the sort of coupling that survives review because nothing about the
 * string says it is load-bearing.
 */
export type MeetingAccessReason = "granted" | "not_found" | "unauthorized";

/** The meeting row does not exist. Nothing further is known about it. */
interface MeetingNotFound {
  hasAccess: false;
  role: null;
  message: string;
  reason: "not_found";
}

/**
 * The meeting exists — so the session and its appointment are always present,
 * whether or not this caller may join.
 *
 * A union rather than one interface with optional fields, because the caller
 * that needs the appointment needs it exactly when `hasAccess` is true, and an
 * optional field forces a `!` or a redundant re-check at every use. Narrowing
 * on `hasAccess` eliminates `MeetingNotFound` and leaves these non-optional.
 */
interface MeetingResolved {
  hasAccess: boolean;
  role: MeetingRole;
  message: string;
  /** Machine-readable verdict. Branch on this, never on `message`. */
  reason: "granted" | "unauthorized";
  streamCallId: string;
  meetingSessionId: string;
  /**
   * The appointment this meeting belongs to, with each plan's owner and
   * `recordingEnabled` — the shape `lib/stream/recording-utils` consumes.
   *
   * Handed back because the consent endpoints were re-querying the same row
   * immediately after the access check. The four plan relations are already
   * joined for the ownership test, so carrying one more column each costs
   * nothing and removes a whole round trip from both handlers.
   */
  appointment: MeetingAppointment;
}

export type MeetingAccess = MeetingNotFound | MeetingResolved;

/** Inferred from the resolver's own query — never hand-maintained. */
type ResolvedMeetingSession = NonNullable<
  Awaited<ReturnType<typeof loadMeetingSession>>
>;
export type MeetingAppointment =
  ResolvedMeetingSession["slotOfAppointment"]["appointment"];

/** Hoisted so `MeetingAppointment` can be inferred from the real query. */
const MEETING_SESSION_INCLUDE = {
      slotOfAppointment: {
        include: {
          user: { select: { id: true } },
          appointment: {
            include: {
              consultation: {
                include: {
                  consultationPlan: {
                    select: {
                      consultantProfileId: true,
                      recordingEnabled: true,
                    },
                  },
                },
              },
              subscription: {
                include: {
                  subscriptionPlan: {
                    select: {
                      consultantProfileId: true,
                      recordingEnabled: true,
                    },
                  },
                },
              },
              webinar: {
                include: {
                  webinarPlan: {
                    select: {
                      id: true,
                      consultantProfileId: true,
                      recordingEnabled: true,
                    },
                  },
                },
              },
              class: {
                include: {
                  classPlan: {
                    select: {
                      id: true,
                      consultantProfileId: true,
                      recordingEnabled: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    } satisfies Prisma.MeetingSessionInclude;

function loadMeetingSession(meetingId: string) {
  return prisma.meetingSession.findUnique({
    where: { streamCallId: meetingId },
    include: MEETING_SESSION_INCLUDE,
  });
}

export async function resolveMeetingAccess(
  meetingId: string,
  userId: string,
): Promise<MeetingAccess> {
  const meetingSession = await loadMeetingSession(meetingId);

  if (!meetingSession) {
    return {
      hasAccess: false,
      role: null,
      message: "Meeting not found",
      reason: "not_found",
    };
  }

  const streamCallId = meetingSession.streamCallId;
  const meetingSessionId = meetingSession.id;
  const appointment = meetingSession.slotOfAppointment.appointment;

  const userProfile = await prisma.user.findUnique({
    where: { id: userId },
    select: { consultantProfileId: true },
  });

  let isParticipant = meetingSession.slotOfAppointment.user.some(
    (u: { id: string }) => u.id === userId,
  );

  const consultantProfileId =
    appointment.consultation?.consultationPlan?.consultantProfileId ??
    appointment.subscription?.subscriptionPlan?.consultantProfileId ??
    appointment.webinar?.webinarPlan?.consultantProfileId ??
    appointment.class?.classPlan?.consultantProfileId ??
    null;

  if (
    consultantProfileId &&
    userProfile?.consultantProfileId === consultantProfileId
  ) {
    return {
      hasAccess: true,
      role: "host",
      message: "Access granted as meeting host",
      reason: "granted",
      streamCallId,
      meetingSessionId,
      appointment,
    };
  }

  // An accepted collaborator on the webinar/class hosts alongside the owner.
  if (userProfile?.consultantProfileId) {
    const webinarPlanId = appointment.webinar?.webinarPlan?.id;
    const classPlanId = appointment.class?.classPlan?.id;

    if (webinarPlanId || classPlanId) {
      const collab = await prisma.collaborator.findFirst({
        where: {
          consultantProfileId: userProfile.consultantProfileId,
          status: "ACCEPTED",
          ...(webinarPlanId ? { webinarPlanId } : { classPlanId }),
        },
        select: { id: true },
      });
      if (collab) {
        return {
          hasAccess: true,
          role: "host",
          message: "Access granted as accepted collaborator",
          reason: "granted",
          streamCallId,
      meetingSessionId,
      appointment,
        };
      }
    }
  }

  // For classes/webinars the meeting hangs off the consultant's allocation slot
  // while the attendee is joined to a separate enrollment slot under the same
  // appointment, so a direct slot check misses them.
  if (!isParticipant && (appointment.class || appointment.webinar)) {
    // An existence probe, not a fan-out: a 200-attendee webinar used to load
    // every slot and every joined user id back into the process to answer a
    // question about one person.
    const enrolledSlot = await prisma.slotOfAppointment.findFirst({
      where: {
        appointmentId: appointment.id,
        user: { some: { id: userId } },
      },
      select: { id: true },
    });
    isParticipant = enrolledSlot !== null;
  }

  if (isParticipant) {
    return {
      hasAccess: true,
      role: "participant",
      message: "Access granted as participant",
      reason: "granted",
      streamCallId,
      meetingSessionId,
      appointment,
    };
  }

  return {
    hasAccess: false,
    role: null,
    message: "You are not authorized to join this meeting",
    reason: "unauthorized",
    streamCallId,
    meetingSessionId,
    appointment,
  };
}
