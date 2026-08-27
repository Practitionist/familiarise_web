/**
 * Recording Details API Route
 * GET /api/stream/recordings/[recordingId]
 *
 * Gets details for a specific recording. Access control based on user role.
 */

import { NextRequest, NextResponse } from "next/server";
import { RecordingService } from "@/lib/stream/recording-service";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";
import prisma from "@/lib/prisma";
import { streamLogger } from "@/lib/stream-logger";
import { isPaymentEntitled } from "@/lib/payments/utils/refund-balance";
import { isPrivileged } from "@/lib/auth-helpers";

import { getSession } from "@/lib/auth-server";
import * as Sentry from "@sentry/nextjs";

/** #366 — a captured standalone replay purchase grants playback. */
async function hasReplayPurchase(
  userId: string,
  recordingId: string,
): Promise<boolean> {
  const purchase = await prisma.recordingPurchase.findFirst({
    where: { recordingId, buyerId: userId, status: "SUCCEEDED" },
    select: { id: true },
  });
  return !!purchase;
}

type RouteParams = {
  params: Promise<{
    recordingId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { recordingId } = await params;

    // Get recording with related data
    const recording = await RecordingService.getRecordingById(recordingId);

    if (!recording) {
      return NextResponse.json(
        { error: "Recording not found" },
        { status: 404 },
      );
    }

    // Check access permissions
    const appointment = recording.meetingSession.slotOfAppointment.appointment;

    let hasAccess = false;

    // Capability, not UserRole (#org-appts): an org EXPERT whose top-level role is CONSULTEE still owns recordings they delivered.
    if (isPrivileged(session.user.role)) {
      // Admin and staff can access all recordings
      hasAccess = true;
    }

    // Provider path: gate on owning a consultant profile, not on role.
    if (!hasAccess && session.user.consultantProfileId) {
      const consultantProfileId = session.user.consultantProfileId;

      if (appointment?.webinar?.webinarPlan) {
        hasAccess =
          appointment.webinar.webinarPlan.consultantProfileId ===
          consultantProfileId;
        if (!hasAccess) {
          const collab = await prisma.collaborator.findFirst({
            where: {
              webinarPlanId: appointment.webinar.webinarPlan.id,
              consultantProfileId,
              status: "ACCEPTED",
            },
          });
          hasAccess = !!collab;
        }
      } else if (appointment?.class?.classPlan) {
        hasAccess =
          appointment.class.classPlan.consultantProfileId ===
          consultantProfileId;
        if (!hasAccess) {
          const collab = await prisma.collaborator.findFirst({
            where: {
              classPlanId: appointment.class.classPlan.id,
              consultantProfileId,
              status: "ACCEPTED",
            },
          });
          hasAccess = !!collab;
        }
      }
    }

    // Attendee path: consultee entitlement, gated on capability not role.
    if (!hasAccess) {
      // Consultee can access recordings for sessions they participated in.
      // Use plan-level entitlement: the recording's appointment is the consultant's
      // allocation slot, not the attendee's enrollment slot, so we check by plan ID.
      const planFilter = appointment?.webinar?.webinarPlan?.id
        ? { webinar: { webinarPlanId: appointment.webinar.webinarPlan.id } }
        : appointment?.class?.classPlan?.id
          ? { class: { classPlanId: appointment.class.classPlan.id } }
          : null;
      if (planFilter) {
        const payments = await prisma.payment.findMany({
          where: {
            userId: session.user.id,
            paymentStatus: "SUCCEEDED",
            appointment: planFilter,
          },
          select: {
            amount: true,
            refunds: { select: { amountPaise: true, status: true } },
          },
        });
        // #689 — a SUCCEEDED payment fully reversed by refunds is no longer an
        // entitlement; access needs at least one net-positive purchase for the plan.
        hasAccess = payments.some(isPaymentEntitled);
      }

      // #366 — standalone replay purchase (marketplace buyers hold no booking
      // on the parent plan, so the payment path above can't see them).
      if (!hasAccess) {
        hasAccess = await hasReplayPurchase(session.user.id, recordingId);
      }
    }

    if (!hasAccess) {
      return NextResponse.json(
        { error: "Access denied to this recording" },
        { status: 403 },
      );
    }

    // Check if Stream URL has expired
    if (
      recording.storageType === "STREAM_S3" &&
      recording.streamUrlExpiresAt &&
      new Date(recording.streamUrlExpiresAt) < new Date()
    ) {
      return NextResponse.json(
        {
          error:
            "Recording has expired on Stream storage. Transfer to permanent storage or sync recordings.",
          expired: true,
        },
        { status: 410 },
      );
    }

    // Get the best available URL (async — generates presigned URL for Supabase)
    const playbackUrl =
      await RecordingTransferService.getBestRecordingUrl(recording);

    return NextResponse.json({
      recording: {
        id: recording.id,
        title: recording.title,
        durationInMinutes: recording.durationInMinutes,
        recordedAt: recording.recordedAt,
        status: recording.status,
        storageType: recording.storageType,
        playbackUrl,
        thumbnailUrl: recording.thumbnailUrl,
        resolution: recording.resolution,
        previewClipUrl: recording.previewClipUrl,
        previewClipDuration: recording.previewClipDuration,
        streamUrlExpiresAt: recording.streamUrlExpiresAt,
        createdAt: recording.createdAt,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    streamLogger.error("Error getting recording", error);
    return NextResponse.json(
      { error: "Failed to get recording" },
      { status: 500 },
    );
  }
}
