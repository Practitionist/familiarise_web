/**
 * Recording Listing API
 * DELETE /api/stream/recordings/[recordingId]/publish — unpublish (keeps copy for re-publish)
 *
 * Publishing is closed until replays are sold as their own product; there is no POST.
 */

import { NextRequest, NextResponse } from "next/server";
import { purgeRecordingSurfaces } from "@/lib/data/public-cache";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { guardOwnedListingRecording } from "@/lib/stream/recording-listing-access";
import { answerFileRoute, fileApiError } from "@/lib/documents/api-error";

type RouteParams = { params: Promise<{ recordingId: string }> };

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user?.id) return fileApiError("UNAUTHORIZED");

    const { recordingId } = await params;
    const guard = await guardOwnedListingRecording(recordingId);
    if (!guard.ok) return fileApiError(guard.code);

    const updated = await prisma.recording.update({
      where: { id: recordingId },
      data: {
        listingStatus: "UNPUBLISHED",
        unpublishedAt: new Date(),
      },
      select: { id: true, listingStatus: true, slug: true },
    });

    // Take the replay off the public library immediately.
    purgeRecordingSurfaces([updated.slug]);

    return NextResponse.json({ data: updated });
  }, "stream");
}
