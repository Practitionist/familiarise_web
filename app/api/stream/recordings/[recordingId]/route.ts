/**
 * Recording Details API Route
 * GET /api/stream/recordings/[recordingId]
 *
 * Gets details for a specific recording. Access is a capability question, not
 * a role question — see the branches below.
 *
 * #1270 — platform operators are no longer a single blanket grant. ADMIN gets
 * the playback URL; STAFF gets metadata and never a URL that renders the
 * session; both are audited. See lib/stream/recording-operator-access.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { RecordingService } from "@/lib/stream/recording-service";
import { getBestRecordingUrl } from "@/lib/stream/recording-storage";
import prisma from "@/lib/prisma";
import { streamLogger } from "@/lib/stream-logger";
import { isPaymentEntitled } from "@/lib/payments/utils/refund-balance";
import {
  hiddenFromLateJoiner,
  lateJoinRecordingAccess,
} from "@/lib/stream/late-join-recordings";
import { liveParticipant } from "@/lib/booking/participants";
import {
  auditOperatorRecordingAccess,
  resolveOperatorRecordingAccess,
} from "@/lib/stream/recording-operator-access";

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
    const session = await getSession(true);
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
    const baseAppointment = recording.meeting.occurrence.appointment;
    type ExtendedAppointment = typeof baseAppointment & {
      participants?: Array<{ userId: string; role?: string }> | null;
      consultation?: {
        requestedById?: string | null;
        consultationPlan?: {
          id?: string;
          consultantProfileId?: string | null;
        } | null;
      } | null;
      subscription?: {
        requestedById?: string | null;
        subscriptionPlan?: {
          id?: string;
          consultantProfileId?: string | null;
        } | null;
      } | null;
      trial?: {
        consulteeProfileId?: string | null;
        status?: string | null;
        subscriptionPlan?: {
          id?: string;
          consultantProfileId?: string | null;
        } | null;
      } | null;
    };
    let appointment = baseAppointment as ExtendedAppointment | null;
    if (
      appointment?.id &&
      !appointment.webinar &&
      !appointment.class &&
      !appointment.consultation &&
      !appointment.subscription &&
      !appointment.trial
    ) {
      const hydrated = await prisma.appointment?.findUnique?.({
        where: { id: appointment.id },
        include: {
          webinar: { include: { webinarPlan: true } },
          class: { include: { classPlan: true } },
          consultation: { include: { consultationPlan: true } },
          subscription: { include: { subscriptionPlan: true } },
          trial: { include: { subscriptionPlan: true } },
          participants: {
            where: liveParticipant(),
            select: { userId: true, role: true },
          },
        },
      });
      if (hydrated) {
        appointment = hydrated as ExtendedAppointment;
      }
    }

    let hasAccess = false;
    // True when the ONLY thing letting this caller through is their platform
    // role. Drives the audit write and the metadata-only downgrade below.
    let viaOperatorGrant = false;

    const operator = resolveOperatorRecordingAccess(session.user.role);

    // #1270 — ADMIN holds `recordings.play`, the widest grant there is, so the
    // ownership walk below cannot add anything for them. Short-circuit.
    if (operator.canPlay) {
      hasAccess = true;
      viaOperatorGrant = true;
    }

    // Capability, not UserRole (#org-appts): an org EXPERT whose top-level role is CONSULTEE still owns recordings they delivered.
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
      } else if (appointment?.consultation?.consultationPlan) {
        hasAccess =
          appointment.consultation.consultationPlan.consultantProfileId ===
          consultantProfileId;
      } else if (appointment?.subscription?.subscriptionPlan) {
        hasAccess =
          appointment.subscription.subscriptionPlan.consultantProfileId ===
          consultantProfileId;
      } else if (appointment?.trial?.subscriptionPlan) {
        hasAccess =
          appointment.trial.subscriptionPlan.consultantProfileId ===
          consultantProfileId;
      }
    }

    // Attendee path: consultee entitlement, gated on capability not role.
    if (!hasAccess) {
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
        hasAccess = payments.some(isPaymentEntitled);
        if (!hasAccess && prisma.appointmentParticipant) {
          const seat = await prisma.appointmentParticipant.findFirst({
            where: {
              userId: session.user.id,
              ...liveParticipant(),
              appointment: planFilter,
            },
            select: { id: true },
          });
          hasAccess = Boolean(seat);
        }
        if (hasAccess && appointment?.class) {
          const lateJoin = await lateJoinRecordingAccess(session.user.id);
          hasAccess = !hiddenFromLateJoiner(recording, lateJoin);
        }
      } else if (appointment?.id) {
        const payments = await prisma.payment.findMany({
          where: {
            userId: session.user.id,
            paymentStatus: "SUCCEEDED",
            appointmentId: appointment.id,
          },
          select: {
            amount: true,
            refunds: { select: { amountPaise: true, status: true } },
          },
        });
        hasAccess = payments.some(isPaymentEntitled);
        if (!hasAccess) {
          hasAccess = Boolean(
            appointment.participants?.some((p) => p.userId === session.user.id),
          );
        }
        if (!hasAccess && prisma.appointmentParticipant) {
          const seat = await prisma.appointmentParticipant.findFirst({
            where: {
              userId: session.user.id,
              appointmentId: appointment.id,
              ...liveParticipant(),
            },
            select: { id: true },
          });
          hasAccess = Boolean(seat);
        }
        if (!hasAccess && session.user.consulteeProfileId) {
          const cpId = session.user.consulteeProfileId;
          if (
            appointment.consultation?.requestedById === cpId ||
            appointment.subscription?.requestedById === cpId ||
            (appointment.trial?.consulteeProfileId === cpId &&
              !["CANCELLED", "REJECTED", "EXPIRED"].includes(
                appointment.trial?.status ?? "",
              ))
          ) {
            hasAccess = true;
          }
        }
      }

      if (!hasAccess) {
        hasAccess = await hasReplayPurchase(session.user.id, recordingId);
      }
    }

    // #1270 — STAFF land here only after every ownership and entitlement path
    // above has failed. A staff member who actually delivered or bought the
    // session already passed one of those and keeps full playback; this branch
    // is the operator with no relationship to the session at all.
    if (!hasAccess && operator.canRead) {
      hasAccess = true;
      viaOperatorGrant = true;
    }

    if (!hasAccess) {
      return NextResponse.json(
        { error: "Access denied to this recording" },
        { status: 403 },
      );
    }

    // Only an operator reaching in on their role alone is capped; anyone who
    // arrived through participation or purchase plays as before.
    const mayPlay = !viaOperatorGrant || operator.canPlay;

    // Written before the URL is minted, so the trail cannot lag the access it
    // describes. A failure here fails the request rather than serving an
    // unaudited read.
    if (viaOperatorGrant) {
      await auditOperatorRecordingAccess({
        actorUserId: session.user.id,
        actorRole: String(session.user.role),
        surface: "GET /api/stream/recordings/[recordingId]",
        played: mayPlay,
        recordingId: recording.id,
        meetingId: recording.meeting?.id ?? null,
        streamCallId: recording.meeting?.streamCallId ?? null,
        organizationId: recording.meeting?.organizationId ?? null,
      });
    }

    // Everything an operator needs to answer "where is my replay" — and
    // nothing that renders the session.
    const metadata = {
      id: recording.id,
      title: recording.title,
      durationInMinutes: recording.durationInMinutes,
      recordedAt: recording.recordedAt,
      status: recording.status,
      storageType: recording.storageType,
      resolution: recording.resolution,
      previewClipDuration: recording.previewClipDuration,
      streamUrlExpiresAt: recording.streamUrlExpiresAt,
      createdAt: recording.createdAt,
    };

    if (!mayPlay) {
      // Every media URL is withheld, not only `playbackUrl`. A thumbnail is a
      // frame of the session and the preview clip is a cut of it, so handing
      // either over is still handing over the content the cap exists to
      // protect. `access.level` is what a consumer branches on — a null URL
      // alone cannot distinguish "not permitted" from "not ready yet".
      return NextResponse.json({
        recording: {
          ...metadata,
          playbackUrl: null,
          thumbnailUrl: null,
          previewClipUrl: null,
        },
        access: {
          level: "METADATA_ONLY" as const,
          reason:
            "Playback requires the recordings.play permission; staff receive metadata only.",
        },
      });
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
    const playbackUrl = await getBestRecordingUrl(recording);

    return NextResponse.json({
      recording: {
        ...metadata,
        playbackUrl,
        thumbnailUrl: recording.thumbnailUrl,
        previewClipUrl: recording.previewClipUrl,
      },
      access: { level: "FULL" as const },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Error getting recording", error);
    return NextResponse.json(
      { error: "Failed to get recording" },
      { status: 500 },
    );
  }
}
