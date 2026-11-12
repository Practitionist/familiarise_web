/**
 * GET mints a playback URL per request for the viewer the slot rule admits;
 * ADMIN plays, STAFF and organisation roles get metadata only (audited).
 * PATCH and DELETE are the host's manage actions.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  RecordingListingStatus,
  RecordingPurchaseStatus,
  RecordingStatus,
  type RecordingRemovalReason,
  RecordingStorageType,
} from "@prisma/client";
import { z } from "zod";
import { RecordingService } from "@/lib/stream/recording-service";
import { getBestRecordingUrl } from "@/lib/stream/recording-storage";
import { purgeExpiredRecordingAssets } from "@/lib/stream/recording-retention";
import prisma from "@/lib/prisma";
import { purgeRecordingSurfaces } from "@/lib/data/public-cache";
import { streamLogger } from "@/lib/stream-logger";
import {
  viewerPlaybackAccess,
  type CatchUpRefusal,
} from "@/lib/stream/recording-slots";
import {
  auditOperatorRecordingAccess,
  resolveOperatorRecordingAccess,
} from "@/lib/stream/recording-operator-access";
import { hasAnyOrgPermission } from "@/lib/auth/org-permissions";

import { requireApiAuth } from "@/lib/auth-helpers";
import { notifyAttendeesOfRemovedRecording } from "@/lib/stream/recording-removal-notice";
import {
  resolveRecordingWriteAccess,
  type RecordingWriteAccess,
} from "@/lib/stream/recording-write-access";
import {
  answerFileRoute,
  fileApiError,
  parseJsonBody,
} from "@/lib/documents/api-error";

type RouteParams = {
  params: Promise<{
    recordingId: string;
  }>;
};

function recordingGoneResponse(recording: {
  removedAt: Date | null;
  removalReason: string | null;
}) {
  return fileApiError("GONE", {
    fields: {
      removedAt: recording.removedAt?.toISOString() ?? null,
      removalReason: recording.removalReason,
    },
  });
}

/**
 * Every media URL is withheld, not only `playbackUrl`: a thumbnail is a frame of the session and the
 * preview clip a cut of it. `access.level` is what a consumer branches on, since a null URL alone is ambiguous.
 */
function metadataOnlyResponse(
  metadata: Record<string, unknown>,
  reason: string,
) {
  return NextResponse.json(
    {
      recording: {
        ...metadata,
        playbackUrl: null,
        thumbnailUrl: null,
        previewClipUrl: null,
        previewTranscript: null,
      },
      access: { level: "METADATA_ONLY" as const, reason },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

/** Org members with operations or catalog roles see the recording's metadata, never the media. */
async function hasOrgMetadataAccess(
  organizationId: string | null,
  userId: string,
): Promise<boolean> {
  if (!organizationId) return false;
  const membership = await prisma.membership.findFirst({
    where: { organizationId, userId, status: "ACTIVE" },
    select: { role: true },
  });
  return (
    !!membership &&
    hasAnyOrgPermission(membership.role, ["operations.read", "catalog.manage"])
  );
}

type PlaybackGrant =
  | { kind: "play"; viaOperatorGrant: boolean }
  | { kind: "metadata" }
  | { kind: "refused"; code: CatchUpRefusal };

/**
 * Operator, then the shared viewer rule (host, own slot, purchase, catch-up);
 * organisation and staff roles get metadata only.
 */
async function resolvePlaybackGrant(
  user: { id: string; role?: string | null },
  recording: NonNullable<
    Awaited<ReturnType<typeof RecordingService.getRecordingById>>
  >,
): Promise<PlaybackGrant> {
  const operator = resolveOperatorRecordingAccess(user.role);
  if (operator.canPlay) return { kind: "play", viaOperatorGrant: true };

  const occurrence = recording.meeting.occurrence;
  const access = await viewerPlaybackAccess(user.id, {
    id: recording.id,
    appointmentId: occurrence.appointmentId,
    ordinal: occurrence.ordinal,
    expired: recording.status === RecordingStatus.EXPIRED,
  });
  if (access.allowed) return { kind: "play", viaOperatorGrant: false };
  if (access.code === "LATE_JOIN_HIDDEN") {
    return { kind: "refused", code: access.code };
  }

  const organizationId =
    recording.organizationId ?? recording.meeting.organizationId ?? null;
  if (
    operator.canRead ||
    (await hasOrgMetadataAccess(organizationId, user.id))
  ) {
    return { kind: "metadata" };
  }
  return { kind: "refused", code: access.code };
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  return answerFileRoute(async () => {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;

    const { recordingId } = await params;
    const recording = await RecordingService.getRecordingById(recordingId);
    if (!recording) return fileApiError("NOT_FOUND");

    const grant = await resolvePlaybackGrant(auth.session.user, recording);
    if (grant.kind === "refused") return fileApiError(grant.code);

    const viaOperatorGrant =
      grant.kind === "metadata" || grant.viaOperatorGrant;
    const mayPlay = grant.kind === "play";
    const streamCopyLapsed =
      recording.storageType === RecordingStorageType.STREAM_S3 &&
      recording.streamUrlExpiresAt !== null &&
      new Date(recording.streamUrlExpiresAt) < new Date();

    if (viaOperatorGrant) {
      await auditOperatorRecordingAccess({
        actorUserId: auth.session.user.id,
        actorRole: String(auth.session.user.role),
        surface: "GET /api/stream/recordings/[recordingId]",
        // Only a response that carries a playback URL counts as played.
        played:
          mayPlay &&
          recording.status !== RecordingStatus.EXPIRED &&
          !streamCopyLapsed,
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

    // An expired recording is gone for everyone except an operator reading its metadata.
    if (recording.status === RecordingStatus.EXPIRED) {
      if (!viaOperatorGrant) return recordingGoneResponse(recording);
      return metadataOnlyResponse(
        metadata,
        "This recording has expired; only its metadata remains.",
      );
    }

    if (!mayPlay) {
      return metadataOnlyResponse(
        metadata,
        "Organisation and staff roles see recording metadata only.",
      );
    }

    if (streamCopyLapsed) return recordingGoneResponse(recording);

    const playbackUrl = getBestRecordingUrl(recording);

    return NextResponse.json(
      {
        recording: {
          ...metadata,
          playbackUrl,
          thumbnailUrl: recording.thumbnailUrl,
          previewClipUrl: recording.previewClipUrl,
          previewTranscript: recording.previewTranscript ?? null,
        },
        access: { level: "FULL" as const },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }, "stream");
}

const patchRecordingSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

function sanitizeRecordingMutationResponse(recording: unknown) {
  if (!recording || typeof recording !== "object") return recording;
  const {
    recordingUrl: _recordingUrl,
    storagePath: _storagePath,
    previewClipStoragePath: _previewClipStoragePath,
    ...safeRecording
  } = recording as Record<string, unknown>;
  return safeRecording;
}

const REMOVAL_REASON = {
  host: "EXPERT_DELETED",
  org: "ORG_ACTION",
  operator: "SUPPORT_ACTION",
} as const satisfies Record<string, RecordingRemovalReason>;

/** Who the attendee notice names: the expert, the organisation, or support. */
function removerName(
  access: Exclude<RecordingWriteAccess, { allowed: false }>,
  actorName: string | null | undefined,
): string {
  if (access.via === "operator") return "Familiarise support";
  if (access.via === "org") return access.orgName;
  return actorName ?? "Your expert";
}

function writeTarget(
  recording: NonNullable<
    Awaited<ReturnType<typeof RecordingService.getRecordingById>>
  >,
) {
  return {
    appointmentId: recording.meeting.occurrence.appointmentId,
    sessionHostProfileId: recording.meeting.occurrence.consultantProfileId,
  };
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  return answerFileRoute(async () => {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;

    const { recordingId } = await params;
    const recording = await RecordingService.getRecordingById(recordingId);
    if (!recording) return fileApiError("NOT_FOUND");

    const access = await resolveRecordingWriteAccess(
      auth.session.user,
      writeTarget(recording),
    );
    if (!access.allowed) return fileApiError("FORBIDDEN");

    const body = await parseJsonBody(req, patchRecordingSchema);

    if (access.via === "operator") {
      await auditOperatorRecordingAccess({
        actorUserId: auth.session.user.id,
        actorRole: String(auth.session.user.role),
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
        ...(body.title !== undefined ? { title: body.title } : {}),
      },
    });

    return NextResponse.json({
      recording: sanitizeRecordingMutationResponse(updated),
    });
  }, "stream");
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  return answerFileRoute(async () => {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;

    const { recordingId } = await params;
    const recording = await RecordingService.getRecordingById(recordingId);
    if (!recording) return fileApiError("NOT_FOUND");

    const access = await resolveRecordingWriteAccess(
      auth.session.user,
      writeTarget(recording),
    );
    if (!access.allowed) return fileApiError("FORBIDDEN");
    // Already removed: a repeat must not re-stamp the removal or re-notify.
    if (recording.status === RecordingStatus.EXPIRED) {
      return recordingGoneResponse(recording);
    }

    // A PENDING or SUCCEEDED purchase blocks deletion whatever the listing status.
    const livePurchase = {
      status: {
        in: [
          RecordingPurchaseStatus.PENDING,
          RecordingPurchaseStatus.SUCCEEDED,
        ],
      },
    };
    const findActivePurchase = () =>
      prisma.recordingPurchase.findFirst({
        where: { recordingId, ...livePurchase },
        select: { id: true },
      });

    const activePurchase = await findActivePurchase();
    if (activePurchase) return fileApiError("RECORDING_HAS_BUYERS");

    if (access.via === "operator") {
      await auditOperatorRecordingAccess({
        actorUserId: auth.session.user.id,
        actorRole: String(auth.session.user.role),
        surface: "DELETE /api/stream/recordings/[recordingId]",
        played: false,
        recordingId: recording.id,
        meetingId: recording.meeting?.id ?? null,
        streamCallId: recording.meeting?.streamCallId ?? null,
        organizationId: recording.meeting?.organizationId ?? null,
      });
    }

    // Unpublish first to close the checkout window before deleting from storage.
    if (recording.listingStatus === RecordingListingStatus.PUBLISHED) {
      await prisma.recording.update({
        where: { id: recordingId },
        data: {
          listingStatus: RecordingListingStatus.UNPUBLISHED,
          unpublishedAt: new Date(),
        },
      });
      purgeRecordingSurfaces();
    }

    // Expire before deleting; the claim refuses a raced status change or a purchase
    // that landed after the check above. A failed delete is retried by expire-recordings.
    const [expired] = await prisma.recording.updateManyAndReturn({
      where: {
        id: recordingId,
        status: recording.status,
        purchases: { none: livePurchase },
      },
      data: {
        status: RecordingStatus.EXPIRED,
        recordingUrl: "",
        listingStatus: RecordingListingStatus.UNPUBLISHED,
        removedAt: new Date(),
        removalReason: REMOVAL_REASON[access.via],
      },
      select: {
        id: true,
        storagePath: true,
        streamCallId: true,
        streamRecordingId: true,
      },
    });
    if (!expired)
      return fileApiError(
        (await findActivePurchase())
          ? "RECORDING_HAS_BUYERS"
          : "RECORDING_CHANGED",
      );
    // The row is already removed, so a failed notice must not fail the delete.
    await notifyAttendeesOfRemovedRecording({
      appointmentId: recording.meeting.occurrence.appointmentId,
      recordingTitle: recording.title,
      removedBy: removerName(access, auth.session.user.name),
    }).catch((error: unknown) => {
      streamLogger.warn("Recording removal notice not sent", {
        recordingId,
        error: error instanceof Error ? error.message : "unknown error",
      });
    });
    // The row is removed from here on: asset and pointer clean-up is best-effort.
    const purged = await purgeExpiredRecordingAssets(expired).catch(
      (error: unknown) => ({
        success: false,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    if (!purged.success) {
      streamLogger.warn("Deleted recording assets left for the expiry sweep", {
        recordingId,
        error: purged.error,
      });
    }
    const updated = await prisma.recording
      .findUnique({ where: { id: recordingId } })
      .catch(() => null);

    return NextResponse.json({
      success: true,
      recording: sanitizeRecordingMutationResponse(updated),
    });
  }, "stream");
}
