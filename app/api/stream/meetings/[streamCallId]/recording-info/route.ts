/**
 * Meeting Recording Info API Route
 * GET /api/stream/meetings/[streamCallId]/recording-info
 *
 * Gets recording information for a meeting session.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { isPaymentEntitled } from "@/lib/payments/utils/refund-balance";

import { getSession } from "@/lib/auth-server";
type RouteParams = {
  params: Promise<{
    streamCallId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { streamCallId } = await params;

    // Find meeting session by streamCallId
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { streamCallId },
      include: {
        slotOfAppointment: {
          include: {
            user: { select: { id: true } },
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: {
                      select: {
                        recordingEnabled: true,
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                class: {
                  include: {
                    classPlan: {
                      select: {
                        recordingEnabled: true,
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                consultation: {
                  include: {
                    consultationPlan: {
                      select: { consultantProfileId: true },
                    },
                    requestedBy: {
                      select: { userId: true },
                    },
                  },
                },
                subscription: {
                  include: {
                    subscriptionPlan: {
                      select: { consultantProfileId: true },
                    },
                    requestedBy: {
                      select: { userId: true },
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
        { error: "Meeting session not found" },
        { status: 404 },
      );
    }

    const appointment = meetingSession.slotOfAppointment?.appointment;

    // Authorization check - verify user has access to this meeting
    const consultantProfileId =
      appointment?.webinar?.webinarPlan?.consultantProfileId ||
      appointment?.class?.classPlan?.consultantProfileId ||
      appointment?.consultation?.consultationPlan?.consultantProfileId ||
      appointment?.subscription?.subscriptionPlan?.consultantProfileId;

    // Admin/Staff can access any meeting
    if (session.user.role !== "ADMIN" && session.user.role !== "STAFF") {
      // Check if user is a participant on this meeting slot
      const slotUserIds =
        meetingSession.slotOfAppointment?.user?.map(
          (u: { id: string }) => u.id,
        ) ?? [];
      const isSlotParticipant = slotUserIds.includes(session.user.id);

      // Consultant can access their own meetings
      if (session.user.role === "CONSULTANT") {
        if (
          session.user.consultantProfileId !== consultantProfileId &&
          !isSlotParticipant
        ) {
          return NextResponse.json({ error: "Access denied" }, { status: 403 });
        }
      } else {
        // Consultee: check if they are a participant on the slot,
        // or the requestedBy user for consultation/subscription,
        // or have a paid enrollment for webinar/class
        const consulteeUserId =
          appointment?.consultation?.requestedBy?.userId ||
          appointment?.subscription?.requestedBy?.userId;
        const isRequestor = consulteeUserId === session.user.id;

        if (!isSlotParticipant && !isRequestor) {
          // Fall back to payment-based enrollment check for webinars/classes
          const webinarId = appointment?.webinar?.id;
          const classId = appointment?.class?.id;

          if (!webinarId && !classId) {
            return NextResponse.json(
              { error: "Access denied" },
              { status: 403 },
            );
          }

          const enrollmentConditions = [];
          if (webinarId) {
            enrollmentConditions.push({ webinarId });
          }
          if (classId) {
            enrollmentConditions.push({ classId });
          }

          const enrollments = await prisma.payment.findMany({
            where: {
              userId: session.user.id,
              paymentStatus: "SUCCEEDED",
              appointment: {
                OR: enrollmentConditions,
              },
            },
            select: {
              amount: true,
              refunds: { select: { amountPaise: true, status: true } },
            },
          });

          // #689 — a fully-refunded enrollment is no longer access.
          if (!enrollments.some(isPaymentEntitled)) {
            return NextResponse.json(
              { error: "Access denied" },
              { status: 403 },
            );
          }
        }
      }
    }

    // Determine if recording is enabled based on appointment type
    let recordingEnabled = false;

    if (appointment?.webinar?.webinarPlan) {
      recordingEnabled = appointment.webinar.webinarPlan.recordingEnabled;
    } else if (appointment?.class?.classPlan) {
      recordingEnabled = appointment.class.classPlan.recordingEnabled;
    }
    // Consultations and subscriptions don't have recordingEnabled on their plans

    return NextResponse.json({
      meetingSessionId: meetingSession.id,
      recordingEnabled,
      isRecording: meetingSession.isRecording,
      recordingStartedAt: meetingSession.recordingStartedAt,
      recordingStartedBy: meetingSession.recordingStartedBy,
    });
  } catch (error) {
    console.error("Error getting meeting recording info:", error);
    return NextResponse.json(
      { error: "Failed to get recording info" },
      { status: 500 },
    );
  }
}
