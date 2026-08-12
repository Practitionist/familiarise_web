import prisma from "@/lib/prisma";

/**
 * #1134 P0-1 — the single definition of "may this user join this meeting".
 *
 * It used to live inline in the validate-access route, which was the ONLY gate
 * on a video call: the meeting page rendered "Access Denied" from a React
 * conditional while the Stream token authorized every call in the app, so
 * `client.call(type, id).join()` from devtools walked straight into a private
 * consultation. The join-token route now shares this function, and the token it
 * mints is scoped to the one call — so the answer here is what Stream enforces,
 * not just what the UI draws.
 */
export type MeetingRole = "host" | "participant" | null;

export interface MeetingAccess {
  hasAccess: boolean;
  role: MeetingRole;
  message: string;
  /** Present only when the meeting exists, regardless of the access verdict. */
  streamCallId?: string;
}

export async function resolveMeetingAccess(
  meetingId: string,
  userId: string,
): Promise<MeetingAccess> {
  const meetingSession = await prisma.meetingSession.findUnique({
    where: { streamCallId: meetingId },
    include: {
      slotOfAppointment: {
        include: {
          user: { select: { id: true } },
          appointment: {
            include: {
              consultation: {
                include: {
                  consultationPlan: { select: { consultantProfileId: true } },
                },
              },
              subscription: {
                include: {
                  subscriptionPlan: { select: { consultantProfileId: true } },
                },
              },
              webinar: {
                include: {
                  webinarPlan: {
                    select: { id: true, consultantProfileId: true },
                  },
                },
              },
              class: {
                include: {
                  classPlan: { select: { id: true, consultantProfileId: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!meetingSession) {
    return { hasAccess: false, role: null, message: "Meeting not found" };
  }

  const streamCallId = meetingSession.streamCallId;

  const userProfile = await prisma.user.findUnique({
    where: { id: userId },
    select: { consultantProfileId: true },
  });

  let isParticipant = meetingSession.slotOfAppointment.user.some(
    (u: { id: string }) => u.id === userId,
  );

  const appointment = meetingSession.slotOfAppointment.appointment;
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
      streamCallId,
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
          streamCallId,
        };
      }
    }
  }

  // For classes/webinars the meeting hangs off the consultant's allocation slot
  // while the attendee is joined to a separate enrollment slot under the same
  // appointment, so a direct slot check misses them.
  if (!isParticipant && (appointment.class || appointment.webinar)) {
    const appointmentWithSlots = await prisma.appointment.findUnique({
      where: { id: appointment.id },
      include: {
        slotsOfAppointment: { include: { user: { select: { id: true } } } },
      },
    });
    isParticipant =
      appointmentWithSlots?.slotsOfAppointment.some((slot) =>
        slot.user.some((u) => u.id === userId),
      ) ?? false;
  }

  if (isParticipant) {
    return {
      hasAccess: true,
      role: "participant",
      message: "Access granted as participant",
      streamCallId,
    };
  }

  return {
    hasAccess: false,
    role: null,
    message: "You are not authorized to join this meeting",
    streamCallId,
  };
}
