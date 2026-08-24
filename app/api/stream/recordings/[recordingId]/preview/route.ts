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
import {
  uploadRecordingPreviewAsset,
  deleteRecordingPreviewAssets,
} from "@/lib/supabase";

type RouteParams = { params: Promise<{ recordingId: string }> };

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { recordingId } = await params;
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });

    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: {
        meetingSession: {
          select: {
            slotOfAppointment: {
              select: {
                appointment: {
                  select: {
                    webinar: {
                      select: {
                        webinarPlan: {
                          select: { consultantProfileId: true },
                        },
                      },
                    },
                    class: {
                      select: {
                        classPlan: { select: { consultantProfileId: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!recording) {
      return NextResponse.json({ error: "Recording not found" }, { status: 404 });
    }

    const apt = recording.meetingSession.slotOfAppointment.appointment;
    const ownerId =
      apt.webinar?.webinarPlan?.consultantProfileId ??
      apt.class?.classPlan?.consultantProfileId;
    if (!ownerId || ownerId !== consultantProfile?.id) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        { error: "Invalid multipart body", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    const clip = formData.get("clip");
    const thumb = formData.get("thumb");
    const updates: Record<string, string | null> = {};

    if (clip instanceof File && clip.size > 0) {
      const result = await uploadRecordingPreviewAsset(recordingId, "clip", clip);
      if (!result.success || !result.url || !result.storagePath) {
        return NextResponse.json(
          { error: result.error ?? "Preview upload failed", code: "UPLOAD_ERROR" },
          { status: 400 },
        );
      }
      updates.previewClipUrl = result.url;
      updates.previewClipStoragePath = result.storagePath;
    }

    if (thumb instanceof File && thumb.size > 0) {
      const result = await uploadRecordingPreviewAsset(recordingId, "thumb", thumb);
      if (!result.success || !result.url || !result.storagePath) {
        return NextResponse.json(
          { error: result.error ?? "Thumbnail upload failed", code: "UPLOAD_ERROR" },
          { status: 400 },
        );
      }
      updates.thumbnailUrl = result.url;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        {
          error: "Provide a `clip` (MP4/WebM ≤50MB) and/or `thumb` (image ≤5MB)",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }

    const updated = await prisma.recording.update({
      where: { id: recordingId },
      data: updates,
      select: {
        id: true,
        previewClipUrl: true,
        thumbnailUrl: true,
      },
    });
    return NextResponse.json({ data: updated });
  } catch (error) {
    console.error("Error uploading recording preview:", error);
    return NextResponse.json(
      { error: "Failed to upload preview" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: RouteParams,
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { recordingId } = await params;
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });

    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: {
        meetingSession: {
          select: {
            slotOfAppointment: {
              select: {
                appointment: {
                  select: {
                    webinar: {
                      select: {
                        webinarPlan: {
                          select: { consultantProfileId: true },
                        },
                      },
                    },
                    class: {
                      select: {
                        classPlan: { select: { consultantProfileId: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!recording) {
      return NextResponse.json({ error: "Recording not found" }, { status: 404 });
    }

    const apt = recording.meetingSession.slotOfAppointment.appointment;
    const ownerId =
      apt.webinar?.webinarPlan?.consultantProfileId ??
      apt.class?.classPlan?.consultantProfileId;
    if (!ownerId || ownerId !== consultantProfile?.id) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    await deleteRecordingPreviewAssets(recordingId);
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
  } catch (error) {
    console.error("Error deleting recording previews:", error);
    return NextResponse.json(
      { error: "Failed to delete previews" },
      { status: 500 },
    );
  }
}
