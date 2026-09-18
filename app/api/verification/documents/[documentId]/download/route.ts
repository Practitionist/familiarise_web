import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase";
import { getSession } from "@/lib/auth-server";
import {
  normalizeDeclaredMime,
  type SniffedMime,
} from "@/lib/storage/sniff-mime";

const INLINE_TYPES: ReadonlySet<string> = new Set<SniffedMime>([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/**
 * GET /api/verification/documents/[documentId]/download
 *
 * Streams a verification document from the private bucket after an ACL
 * check: the uploader, the consultant whose request it belongs to, or
 * platform ADMIN/STAFF. Replaces the one-hour signed URL that used to be
 * persisted in `fileUrl` — staff review a request days after upload, so
 * every stored link had expired by the time anyone clicked it. Mirrors
 * app/api/appointments/[appointmentId]/documents/[documentId]/download.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  try {
    const { documentId } = await params;
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const document = await prisma.profileVerificationDocument.findUnique({
      where: { id: documentId },
      select: {
        storagePath: true,
        originalName: true,
        mimeType: true,
        uploadedByUserId: true,
        verification: {
          select: { consultantProfile: { select: { userId: true } } },
        },
      },
    });
    if (!document) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const role = session.user.role;
    const isReviewer = role === "ADMIN" || role === "STAFF";
    const isOwner =
      document.uploadedByUserId === session.user.id ||
      document.verification?.consultantProfile.userId === session.user.id;
    if (!isReviewer && !isOwner) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Document storage is not configured" },
        { status: 503 },
      );
    }
    const { data, error } = await supabaseAdmin.storage
      .from("documents")
      .download(document.storagePath);
    if (error || !data) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "verification" } },
      );
      return NextResponse.json(
        { error: "Unable to retrieve the file from storage" },
        { status: 502 },
      );
    }

    const body = Buffer.from(await data.arrayBuffer());
    const safeName = document.originalName.replace(/[^\w.-]+/g, "_");
    // Only a byte-verified type renders inline; a legacy row's declared type
    // was never sniffed, so anything else downloads as an opaque attachment.
    const inline = INLINE_TYPES.has(normalizeDeclaredMime(document.mimeType));
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": inline ? document.mimeType : "application/octet-stream",
        "Content-Length": String(body.length),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "verification" } },
    );
    return NextResponse.json({ error: "Download failed" }, { status: 500 });
  }
}
