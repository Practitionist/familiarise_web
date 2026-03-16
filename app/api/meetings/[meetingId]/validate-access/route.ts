import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

/**
 * Validates if a user has access to a specific meeting
 * GET /api/meetings/[meetingId]/validate-access
 *
 * Returns:
 * - hasAccess: boolean
 * - role: "host" | "participant" | null
 * - message: string describing the result
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  try {
    // Get current session
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return NextResponse.json(
        { hasAccess: false, role: null, message: "Authentication required" },
        { status: 401 },
      );
    }

    const { meetingId } = await params;
    const userId = session.user.id;

    if (!meetingId) {
      return NextResponse.json(
        { hasAccess: false, role: null, message: "Meeting ID is required" },
        { status: 400 },
      );
    }

    // Find the meeting session by streamCallId
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { streamCallId: meetingId },
      include: {
        slotOfAppointment: {
          include: {
            user: {
              select: { id: true },
            },
            appointment: {
              include: {
                consultation: {
                  include: {
                    consultationPlan: {
                      select: { consultantProfileId: true },
                    },
                  },
                },
                subscription: {
                  include: {
                    subscriptionPlan: {
                      select: { consultantProfileId: true },
                    },
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
                    classPlan: {
                      select: { id: true, consultantProfileId: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!meetingSession) {
      return NextResponse.json(
        { hasAccess: false, role: null, message: "Meeting not found" },
        { status: 404 },
      );
    }

    // Get the user's consultant profile ID if they have one
    const userProfile = await prisma.user.findUnique({
      where: { id: userId },
      select: { consultantProfileId: true },
    });

    // Check if user is a participant in this slot
    let isParticipant = meetingSession.slotOfAppointment.user.some(
      (u: { id: string }) => u.id === userId,
    );

    // Check if user is the consultant (host) for this appointment
    const appointment = meetingSession.slotOfAppointment.appointment;
    let consultantProfileId: string | null = null;

    if (appointment.consultation?.consultationPlan?.consultantProfileId) {
      consultantProfileId =
        appointment.consultation.consultationPlan.consultantProfileId;
    } else if (
      appointment.subscription?.subscriptionPlan?.consultantProfileId
    ) {
      consultantProfileId =
        appointment.subscription.subscriptionPlan.consultantProfileId;
    } else if (appointment.webinar?.webinarPlan?.consultantProfileId) {
      consultantProfileId = appointment.webinar.webinarPlan.consultantProfileId;
    } else if (appointment.class?.classPlan?.consultantProfileId) {
      consultantProfileId = appointment.class.classPlan.consultantProfileId;
    }

    const isHost =
      userProfile?.consultantProfileId === consultantProfileId &&
      !!consultantProfileId;

    if (isHost) {
      return NextResponse.json({
        hasAccess: true,
        role: "host",
        message: "Access granted as meeting host",
      });
    }

    // Check if user is an accepted collaborator on the webinar/class (host-equivalent)
    if (userProfile?.consultantProfileId) {
      const webinarPlanId = appointment.webinar?.webinarPlan?.id;
      const classPlanId = appointment.class?.classPlan?.id;

      if (webinarPlanId) {
        const collab = await prisma.webinarCollaborator.findFirst({
          where: {
            webinarPlanId,
            consultantProfileId: userProfile.consultantProfileId,
            status: "ACCEPTED",
          },
        });
        if (collab) {
          return NextResponse.json({
            hasAccess: true,
            role: "host",
            message: "Access granted as accepted collaborator",
          });
        }
      }

      if (classPlanId) {
        const collab = await prisma.classCollaborator.findFirst({
          where: {
            classPlanId,
            consultantProfileId: userProfile.consultantProfileId,
            status: "ACCEPTED",
          },
        });
        if (collab) {
          return NextResponse.json({
            hasAccess: true,
            role: "host",
            message: "Access granted as accepted collaborator",
          });
        }
      }
    }

    // For classes/webinars, the meeting is created on the consultant's allocation
    // slot, but the consultee is connected to a separate enrollment slot under the
    // same appointment. Check all appointment slots if the direct slot check fails.
    if (!isParticipant && (appointment.class || appointment.webinar)) {
      const appointmentWithSlots = await prisma.appointment.findUnique({
        where: { id: appointment.id },
        include: {
          slotsOfAppointment: {
            include: {
              user: { select: { id: true } },
            },
          },
        },
      });

      isParticipant =
        appointmentWithSlots?.slotsOfAppointment.some((slot) =>
          slot.user.some((u) => u.id === userId),
        ) ?? false;
    }

    if (isParticipant) {
      return NextResponse.json({
        hasAccess: true,
        role: "participant",
        message: "Access granted as participant",
      });
    }

    return NextResponse.json({
      hasAccess: false,
      role: null,
      message: "You are not authorized to join this meeting",
    });
  } catch (error) {
    console.error("Error validating meeting access:", error);
    return NextResponse.json(
      { hasAccess: false, role: null, message: "Failed to validate access" },
      { status: 500 },
    );
  }
}
