/**
 * Recording Listing Preview Assets (#366)
 * POST   /api/stream/recordings/[recordingId]/preview — upload clip and/or thumbnail
 * DELETE /api/stream/recordings/[recordingId]/preview — remove preview assets
 *
 * Preview assets are PUBLIC marketing material for explore cards (ISR-cached,
 * anonymous traffic) — they live in the public `recordings-previews` bucket,
 * never in the private recordings bucket.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { answerFileRoute, fileApiError } from "@/lib/documents/api-error";
import { guardOwnedListingRecording } from "@/lib/stream/recording-listing-access";
import {
  uploadRecordingPreviewAsset,
  deleteRecordingPreviewAssets,
} from "@/lib/supabase";

type RouteParams = { params: Promise<{ recordingId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user?.id) return fileApiError("UNAUTHORIZED");

    const { recordingId } = await params;
    const guard = await guardOwnedListingRecording(recordingId);
    if (!guard.ok) return fileApiError(guard.code);

    const formData = await request.formData().catch(() => null);
    if (!formData) return fileApiError("INVALID_INPUT");

    const clip = formData.get("clip");
    const thumb = formData.get("thumb");
    if (
      !(clip instanceof File && clip.size > 0) &&
      !(thumb instanceof File && thumb.size > 0)
    ) {
      return fileApiError("FILE_MISSING");
    }

    // A clip that landed is saved even when the thumbnail then fails, so no stored object is left without a pointer.
    const updates: {
      previewClipUrl?: string;
      previewClipStoragePath?: string;
      thumbnailUrl?: string;
    } = {};
    let thumbFailed = false;

    if (clip instanceof File && clip.size > 0) {
      const result = await uploadRecordingPreviewAsset(
        recordingId,
        "clip",
        clip,
      );
      if (!(result.success && result.url && result.storagePath)) {
        return fileApiError("PREVIEW_UPLOAD_FAILED");
      }
      updates.previewClipUrl = result.url;
      updates.previewClipStoragePath = result.storagePath;
    }

    if (thumb instanceof File && thumb.size > 0) {
      const result = await uploadRecordingPreviewAsset(
        recordingId,
        "thumb",
        thumb,
      );
      if (result.success && result.url && result.storagePath) {
        updates.thumbnailUrl = result.url;
      } else {
        thumbFailed = true;
      }
    }

    if (Object.keys(updates).length > 0) {
      await prisma.recording.update({
        where: { id: recordingId },
        data: updates,
        select: { id: true },
      });
    }

    if (thumbFailed) {
      return fileApiError(
        Object.keys(updates).length > 0
          ? "PARTIAL_UPLOAD"
          : "PREVIEW_UPLOAD_FAILED",
        { fields: { persisted: Object.keys(updates) } },
      );
    }

    const updated = await prisma.recording.findUniqueOrThrow({
      where: { id: recordingId },
      select: { id: true, previewClipUrl: true, thumbnailUrl: true },
    });
    return NextResponse.json({ data: updated });
  }, "stream");
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user?.id) return fileApiError("UNAUTHORIZED");

    const { recordingId } = await params;
    const guard = await guardOwnedListingRecording(recordingId);
    if (!guard.ok) return fileApiError(guard.code);

    if (!(await deleteRecordingPreviewAssets(recordingId))) {
      return fileApiError("STORAGE_UNAVAILABLE");
    }
    const updated = await prisma.recording.update({
      where: { id: recordingId },
      data: {
        previewClipUrl: null,
        previewClipStoragePath: null,
        previewClipDuration: null,
        thumbnailUrl: null,
      },
      select: { id: true },
    });
    return NextResponse.json({ data: updated });
  }, "stream");
}
