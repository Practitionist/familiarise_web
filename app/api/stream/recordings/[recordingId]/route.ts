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
import { z } from "zod";
import { RecordingService } from "@/lib/stream/recording-service";
import {
  deleteRecordingObject,
  getBestRecordingUrl,
} from "@/lib/stream/recording-storage";
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
import { hasAnyOrgPermission } from "@/lib/auth/org-permissions";

import { getSession } from "@/lib/auth-server";
import * as Sentry from "@sentry/nextjs";

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
    const session = await getSession(true);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { recordingId } = await params;

    const recording = await RecordingService.getRecordingById(recordingId);

    if (!recording) {
      return NextResponse.json(
        { error: "Recording not found" },
        { status: 404 },
      );
    }

    const baseAppointment = recording.meeting.occurrence.appointment;
    type ExtendedAppointment = typeof baseAppointment & {
      organizationId?: string | null;
      participants?: Array<{ userId: string; role?: string }> | null;
      consultation?: {
        requestedById?: string | null;
        consultationPlan?: {
          id?: string;
          consultantProfileId?: string | null;
          organizationId?: string | null;
        } | null;
      } | null;
      subscription?: {
        requestedById?: string | null;
        subscriptionPlan?: {
          id?: string;
          consultantProfileId?: string | null;
          organizationId?: string | null;
        } | null;
      } | null;
      trial?: {
        consulteeProfileId?: string | null;
        status?: string | null;
        subscriptionPlan?: {
          id?: string;
          consultantProfileId?: string | null;
          organizationId?: string | null;
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
    let viaOperatorGrant = false;

    const operator = resolveOperatorRecordingAccess(session.user.role);

    if (operator.canPlay) {
      hasAccess = true;
      viaOperatorGrant = true;
    }

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
              tier: "PRESENTER",
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
              tier: "PRESENTER",
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

    const resolvedOrgId =
      recording.organizationId ??
      recording.meeting?.organizationId ??
      appointment?.organizationId ??
      appointment?.webinar?.webinarPlan?.organizationId ??
      appointment?.class?.classPlan?.organizationId ??
      null;

    if (!hasAccess && resolvedOrgId && prisma.membership?.findFirst) {
      const membership = await prisma.membership.findFirst({
        where: {
          organizationId: resolvedOrgId,
          userId: session.user.id,
          status: "ACTIVE",
        },
        select: { role: true },
      });
      if (
        membership &&
        hasAnyOrgPermission(membership.role, [
          "operations.read",
          "catalog.manage",
        ])
      ) {
        hasAccess = true;
      }
    }

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
              role: "CONSULTEE",
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
            appointment.participants?.some(
              (p) =>
                p.userId === session.user.id &&
                (!p.role || p.role === "CONSULTEE"),
            ),
          );
        }
        if (!hasAccess && prisma.appointmentParticipant) {
          const seat = await prisma.appointmentParticipant.findFirst({
            where: {
              userId: session.user.id,
              role: "CONSULTEE",
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

    const mayPlay = !viaOperatorGrant || operator.canPlay;

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
      return NextResponse.json({
        recording: {
          ...metadata,
          playbackUrl: null,
          thumbnailUrl: null,
          previewClipUrl: null,
          previewTranscript: null,
        },
        access: {
          level: "METADATA_ONLY" as const,
          reason:
            "Playback requires the recordings.play permission; staff receive metadata only.",
        },
      });
    }

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

    const playbackUrl = await getBestRecordingUrl(recording);

    return NextResponse.json({
      recording: {
        ...metadata,
        playbackUrl,
        thumbnailUrl: recording.thumbnailUrl,
        previewClipUrl: recording.previewClipUrl,
        previewTranscript: recording.previewTranscript ?? null,
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

const patchRecordingSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

function sanitizeRecordingMutationResponse(recording: unknown) {
  if (!recording || typeof recording !== "object") return recording;
  const {
    recordingUrl: _recordingUrl,
    storageUrl: _storageUrl,
    storagePath: _storagePath,
    previewClipStoragePath: _previewClipStoragePath,
    ...safeRecording
  } = recording as Record<string, unknown>;
  return safeRecording;
}

type OwnedPlan = {
  id?: string;
  organizationId?: string | null;
  consultantProfileId?: string | null;
  consultantProfile?: { userId?: string | null } | null;
} | null;

async function resolveRecordingWriteAccess(
  user: {
    id: string;
    role?: string | null;
    consultantProfileId?: string | null;
  },
  recording: NonNullable<
    Awaited<ReturnType<typeof RecordingService.getRecordingById>>
  >,
): Promise<{ allowed: boolean; viaOperatorGrant: boolean }> {
  let consultantProfileId = user.consultantProfileId ?? null;
  if (!consultantProfileId && prisma.consultantProfile?.findUnique) {
    const profile = await prisma.consultantProfile.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    consultantProfileId = profile?.id ?? null;
  }

  const occurrence = recording.meeting?.occurrence as
    | {
        consultantProfileId?: string | null;
        appointment?: unknown;
      }
    | undefined;

  if (
    consultantProfileId &&
    occurrence?.consultantProfileId === consultantProfileId
  ) {
    return { allowed: true, viaOperatorGrant: false };
  }

  const appointment = occurrence?.appointment as
    | {
        organizationId?: string | null;
        webinar?: { webinarPlan?: OwnedPlan } | null;
        class?: { classPlan?: OwnedPlan } | null;
        consultation?: { consultationPlan?: OwnedPlan } | null;
        subscription?: { subscriptionPlan?: OwnedPlan } | null;
        trial?: { subscriptionPlan?: OwnedPlan } | null;
      }
    | undefined;

  const plans = [
    appointment?.webinar?.webinarPlan,
    appointment?.class?.classPlan,
    appointment?.consultation?.consultationPlan,
    appointment?.subscription?.subscriptionPlan,
    appointment?.trial?.subscriptionPlan,
  ];

  const ownsAnyPlan = plans.some(
    (plan) =>
      Boolean(plan) &&
      ((Boolean(consultantProfileId) &&
        plan?.consultantProfileId === consultantProfileId) ||
        plan?.consultantProfile?.userId === user.id),
  );
  if (ownsAnyPlan) {
    return { allowed: true, viaOperatorGrant: false };
  }

  const orgId =
    recording.organizationId ??
    recording.meeting?.organizationId ??
    appointment?.organizationId ??
    appointment?.webinar?.webinarPlan?.organizationId ??
    appointment?.class?.classPlan?.organizationId ??
    null;

  if (orgId && prisma.membership?.findFirst) {
    const membership = await prisma.membership.findFirst({
      where: {
        organizationId: orgId,
        userId: user.id,
        status: "ACTIVE",
      },
      select: { role: true },
    });
    if (
      membership &&
      hasAnyOrgPermission(membership.role, ["catalog.manage"])
    ) {
      return { allowed: true, viaOperatorGrant: false };
    }
  }

  const operator = resolveOperatorRecordingAccess(user.role);
  if (operator.canPlay) {
    return { allowed: true, viaOperatorGrant: true };
  }

  return { allowed: false, viaOperatorGrant: false };
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession(true);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { recordingId } = await params;
    const recording = await RecordingService.getRecordingById(recordingId);
    if (!recording) {
      return NextResponse.json(
        { error: "Recording not found" },
        { status: 404 },
      );
    }

    const { allowed, viaOperatorGrant } = await resolveRecordingWriteAccess(
      session.user,
      recording,
    );
    if (!allowed) {
      return NextResponse.json(
        {
          error:
            "Forbidden: only the host consultant or an admin may update this recording",
        },
        { status: 403 },
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = patchRecordingSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    if (viaOperatorGrant) {
      await auditOperatorRecordingAccess({
        actorUserId: session.user.id,
        actorRole: String(session.user.role),
        surface: "PATCH /api/stream/recordings/[recordingId]",
        played: false,
        recordingId: recording.id,
        meetingId: recording.meeting?.id ?? null,
        streamCallId: recording.meeting?.streamCallId ?? null,
        organizationId: recording.meeting?.organizationId ?? null,
      });
    }

    const updated = await prisma.recording.update({
      where: { id: recordingId },
      data: {
        ...(parsed.data.title !== undefined
          ? { title: parsed.data.title }
          : {}),
      },
    });

    return NextResponse.json({
      recording: sanitizeRecordingMutationResponse(updated),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Error updating recording", error);
    return NextResponse.json(
      { error: "Failed to update recording" },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession(true);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { recordingId } = await params;
    const recording = await RecordingService.getRecordingById(recordingId);
    if (!recording) {
      return NextResponse.json(
        { error: "Recording not found" },
        { status: 404 },
      );
    }

    const { allowed, viaOperatorGrant } = await resolveRecordingWriteAccess(
      session.user,
      recording,
    );
    if (!allowed) {
      return NextResponse.json(
        {
          error:
            "Forbidden: only the host consultant or an admin may delete this recording",
        },
        { status: 403 },
      );
    }

    const recWithListing = recording as typeof recording & {
      listingStatus?: string | null;
      previewClipStoragePath?: string | null;
    };

    // Always block deletion when any PENDING or SUCCEEDED purchase exists,
    // regardless of current listingStatus (prevents unpublish-then-delete bypass).
    const findActivePurchase = () =>
      prisma.recordingPurchase?.findFirst?.({
        where: {
          recordingId,
          status: { in: ["PENDING", "SUCCEEDED"] },
        },
        select: { id: true },
      });

    const activePurchase = await findActivePurchase();
    if (activePurchase) {
      return NextResponse.json(
        {
          error: "Cannot delete a recording that has active or pending buyers",
        },
        { status: 409 },
      );
    }

    if (viaOperatorGrant) {
      await auditOperatorRecordingAccess({
        actorUserId: session.user.id,
        actorRole: String(session.user.role),
        surface: "DELETE /api/stream/recordings/[recordingId]",
        played: false,
        recordingId: recording.id,
        meetingId: recording.meeting?.id ?? null,
        streamCallId: recording.meeting?.streamCallId ?? null,
        organizationId: recording.meeting?.organizationId ?? null,
      });
    }

    // If the recording was PUBLISHED, unpublish it first to close the checkout
    // window before deleting objects from storage, then re-verify no purchase
    // raced in while PUBLISHED.
    if (recWithListing.listingStatus === "PUBLISHED") {
      await prisma.recording.update({
        where: { id: recordingId },
        data: {
          listingStatus: "UNPUBLISHED",
          unpublishedAt: new Date(),
        },
      });
      const racedPurchase = await findActivePurchase();
      if (racedPurchase) {
        return NextResponse.json(
          {
            error:
              "Cannot delete a recording that has active or pending buyers",
          },
          { status: 409 },
        );
      }
    }

    if (recording.storagePath) {
      const deletedMain = await deleteRecordingObject(recording.storagePath);
      if (!deletedMain.success) {
        return NextResponse.json(
          {
            error:
              deletedMain.error ?? "Failed to delete recording storage object",
          },
          { status: 500 },
        );
      }
    }

    if (recWithListing.previewClipStoragePath) {
      await deleteRecordingObject(recWithListing.previewClipStoragePath);
    }

    const updated = await prisma.recording.update({
      where: { id: recordingId },
      data: {
        status: "EXPIRED",
        recordingUrl: "",
        storageUrl: null,
        storagePath: null,
        previewClipUrl: null,
        previewClipStoragePath: null,
        listingStatus: "UNPUBLISHED",
      },
    });

    return NextResponse.json({
      success: true,
      recording: sanitizeRecordingMutationResponse(updated),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Error deleting recording", error);
    return NextResponse.json(
      { error: "Failed to delete recording" },
      { status: 500 },
    );
  }
}
