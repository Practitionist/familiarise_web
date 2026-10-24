import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, documentUploadUrlLimiter } from "@/lib/rate-limit";
import {
  generateStorageFileName,
  supabaseAdmin,
} from "@/lib/supabase-storage-core";
import {
  FileRouteError,
  answerFileRoute,
  fileApiError,
  parseJsonBody,
} from "@/lib/documents/api-error";
import { checkDocumentThreadSlot } from "@/lib/documents/document-review";
import {
  UploadUrlRequestSchema,
  checkDeclaredFile,
  documentFolder,
  requireWritableParty,
} from "@/lib/documents/upload-pipeline";

type RouteContext = { params: Promise<{ appointmentId: string }> };

/** Mints a single-use upload URL after the same checks the commit repeats under the booking lock. */
export async function POST(request: Request, { params }: RouteContext) {
  return answerFileRoute(async () => {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const limited = await applyRateLimit(
      documentUploadUrlLimiter,
      auth.session.user.id,
    );
    if (limited) return limited;

    const { appointmentId } = await params;
    const body = await parseJsonBody(request, UploadUrlRequestSchema);
    const mimeType = checkDeclaredFile(body);

    const party = await requireWritableParty(
      prisma,
      appointmentId,
      auth.session.user.id,
    );
    const parentDocumentId = body.parentDocumentId ?? null;
    if (party.role === "expert" && parentDocumentId) {
      // An expert reply file; the review route allocates its version.
      const parent = await prisma.appointmentDocument.count({
        where: {
          id: parentDocumentId,
          appointmentId,
          deletedAt: null,
          uploadedByRole: "CONSULTEE",
        },
      });
      if (parent === 0) throw new FileRouteError("INVALID_THREAD_PARENT");
    } else {
      const slot = await checkDocumentThreadSlot(prisma, {
        appointmentId,
        parentDocumentId,
        uploadedByRole: party.role === "expert" ? "CONSULTANT" : "CONSULTEE",
      });
      if (!slot.ok) throw new FileRouteError(slot.code);
    }

    if (!supabaseAdmin) throw new FileRouteError("STORAGE_UNAVAILABLE");
    const storagePath = `${documentFolder(party)}/${generateStorageFileName(mimeType)}`;
    const { data, error } = await supabaseAdmin.storage
      .from("documents")
      .createSignedUploadUrl(storagePath, { upsert: false });
    if (error || !data?.signedUrl) {
      Sentry.captureException(error ?? new Error("No signed upload URL"), {
        tags: { subsystem: "storage" },
      });
      throw new FileRouteError("STORAGE_UNAVAILABLE");
    }

    return NextResponse.json(
      { uploadUrl: data.signedUrl, storagePath, mimeType },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  });
}
