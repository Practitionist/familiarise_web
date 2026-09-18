import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  uploadToSupabase,
  deleteFromSupabase,
  generateStorageFileName,
} from "@/lib/supabase";
import { getSession } from "@/lib/auth-server";
import { canUploadVerificationDoc } from "@/utils/onboarding-shared";
import { applyRateLimit, documentUploadLimiter } from "@/lib/rate-limit";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import {
  declaredMimeMatchesBytes,
  normalizeDeclaredMime,
} from "@/lib/storage/sniff-mime";
import {
  decideUploadAdmission,
  documentDownloadPath,
  loadUploadCounters,
  type UploadRefusal,
} from "@/lib/verification/documents";
import * as Sentry from "@sentry/nextjs";

const ALLOWED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "application/pdf",
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

class UploadRefusedError extends Error {
  constructor(readonly refusal: UploadRefusal) {
    super(refusal.code);
  }
}

/**
 * POST /api/verification/documents
 * Upload a verification document.
 *
 * A row is created for EVERY upload, unlinked (`verificationId` null) until a
 * submission links it. That is what gives the document an owner (#1224), a
 * place in the uploader's byte quota, a delete path, and a sweep when it is
 * abandoned. The `onboarding=true` flag only decides the gate for a caller
 * with no consultant profile yet (the wizard) — the write is the same.
 */
export async function POST(request: NextRequest) {
  let uploadedStoragePath: string | null = null;
  try {
    // Force-fresh: a revoked/erased/banned user must lose upload within the
    // call, not up to 5 minutes later on the cookie cache.
    const session = await getSession(true);

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }
    const userId = session.user.id;

    // Every upload touches Supabase Storage, so an unthrottled loop balloons
    // storage cost; the quota below bounds the total, the limiter the rate.
    const rateLimited = await applyRateLimit(
      documentUploadLimiter,
      `verification-docs:${userId}`,
    );
    if (rateLimited) return rateLimited;

    const formData = await request.formData();
    const file = formData.get("file") as File;
    const description = formData.get("description") as string | null;
    const isOnboarding = formData.get("onboarding") === "true";

    if (!file) {
      return NextResponse.json(
        { success: false, error: "No file provided" },
        { status: 400 },
      );
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid file type. Allowed: PNG, JPG, WEBP, PDF",
        },
        { status: 400 },
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { success: false, error: "File size exceeds 10MB limit" },
        { status: 400 },
      );
    }

    // The declared type is whatever the client said; the bytes decide.
    const buffer = Buffer.from(await file.arrayBuffer());
    if (!declaredMimeMatchesBytes(file.type, new Uint8Array(buffer))) {
      return NextResponse.json(
        {
          success: false,
          error:
            "The file's contents do not match its type. Upload a real PDF, PNG, JPG or WEBP.",
        },
        { status: 400 },
      );
    }
    const mimeType = normalizeDeclaredMime(file.type);

    // Gate: a caller with no consultant profile may upload only from the
    // consultant wizard (draft role picked at step 0 and autosaved).
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!consultantProfile) {
      const draft = await prisma.onboardingDraft.findUnique({
        where: { userId },
        select: { role: true },
      });
      if (
        !canUploadVerificationDoc({
          isOnboardingMode: isOnboarding,
          hasConsultantProfile: false,
          draftRole: draft?.role ?? null,
        })
      ) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Verification uploads during onboarding require the consultant path. Pick the consultant role and save your progress, then try again.",
          },
          { status: 403 },
        );
      }
    }

    // Pre-flight admission (quota + outstanding cap) so a refusal costs no
    // storage write; re-checked inside the transaction that inserts the row.
    const preflight = decideUploadAdmission({
      incomingBytes: file.size,
      ...(await loadUploadCounters(prisma, userId, null)),
      linkingToRequest: false,
    });
    if (preflight) {
      return NextResponse.json(
        { success: false, error: preflight.message, code: preflight.code },
        { status: 400 },
      );
    }

    const fileName = generateStorageFileName(mimeType);
    const storagePath = `verification/${userId}/${fileName}`;
    const { url: signedUrl, error: uploadError } = await uploadToSupabase(
      storagePath,
      buffer,
      mimeType,
    );
    if (uploadError || !signedUrl) {
      return NextResponse.json(
        { success: false, error: uploadError || "Failed to upload file" },
        { status: 500 },
      );
    }
    uploadedStoragePath = storagePath;

    // The row, with the admission re-checked under Serializable so a burst of
    // parallel uploads cannot each see "one below the cap" (the count-cap race
    // CodeRabbit flagged on #1698). The stored fileUrl is the ACL'd download
    // route, never the one-hour signed URL the upload helper hands back.
    const document = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const admission = decideUploadAdmission({
            incomingBytes: file.size,
            ...(await loadUploadCounters(tx, userId, null)),
            linkingToRequest: false,
          });
          if (admission) throw new UploadRefusedError(admission);
          const created = await tx.profileVerificationDocument.create({
            data: {
              uploadedByUserId: userId,
              verificationId: null,
              fileName,
              originalName: file.name,
              fileSize: file.size,
              mimeType,
              fileUrl: "", // patched below once the id exists
              storagePath,
              description: description || undefined,
            },
          });
          return tx.profileVerificationDocument.update({
            where: { id: created.id },
            data: { fileUrl: documentDownloadPath(created.id) },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
    uploadedStoragePath = null;

    return NextResponse.json({
      success: true,
      data: {
        id: document.id,
        fileName: document.fileName,
        originalName: document.originalName,
        fileSize: document.fileSize,
        mimeType: document.mimeType,
        fileUrl: document.fileUrl,
        storagePath: document.storagePath,
        description: document.description,
        status: "uploaded",
        // A row now exists for every upload; onboarding completion links by id.
        isOnboardingUpload: false,
      },
    });
  } catch (error) {
    // The object is already in storage; a refused or failed row must not
    // leave it orphaned until the sweep.
    if (uploadedStoragePath) {
      await deleteFromSupabase(uploadedStoragePath).catch(() => undefined);
    }
    if (error instanceof UploadRefusedError) {
      return NextResponse.json(
        {
          success: false,
          error: error.refusal.message,
          code: error.refusal.code,
        },
        { status: 400 },
      );
    }
    console.error("Document upload error:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "verification" } },
    );
    return NextResponse.json(
      { success: false, error: "Failed to upload document" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/verification/documents?id=...
 * The owner removes an unlinked upload, or a document on a request that is
 * still open (PENDING / NEEDS_INFO). Decided documents stay for the record.
 */
export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession(true);

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const { searchParams } = new URL(request.url);
    const documentId = searchParams.get("id");

    if (!documentId) {
      return NextResponse.json(
        { success: false, error: "Document ID required" },
        { status: 400 },
      );
    }

    const document = await prisma.profileVerificationDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        storagePath: true,
        uploadedByUserId: true,
        verification: {
          select: {
            status: true,
            consultantProfile: { select: { userId: true } },
          },
        },
      },
    });

    if (!document) {
      return NextResponse.json(
        { success: false, error: "Document not found" },
        { status: 404 },
      );
    }

    // Owner = uploader; a legacy row with no uploader falls back to the
    // profile that owns its request.
    const ownerUserId =
      document.uploadedByUserId ??
      document.verification?.consultantProfile.userId ??
      null;
    if (ownerUserId !== session.user.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 403 },
      );
    }

    if (
      document.verification &&
      document.verification.status !== "PENDING" &&
      document.verification.status !== "NEEDS_INFO"
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Cannot delete documents from processed verification",
        },
        { status: 400 },
      );
    }

    await deleteFromSupabase(document.storagePath);
    await prisma.profileVerificationDocument.delete({
      where: { id: documentId },
    });

    return NextResponse.json({
      success: true,
      message: "Document deleted successfully",
    });
  } catch (error) {
    console.error("Document delete error:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "verification" } },
    );
    return NextResponse.json(
      { success: false, error: "Failed to delete document" },
      { status: 500 },
    );
  }
}
