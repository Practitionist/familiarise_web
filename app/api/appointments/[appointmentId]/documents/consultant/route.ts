import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse, after } from "next/server";
import prisma from "@/lib/prisma";
import {
  uploadConsultantDocument,
  deleteAppointmentDocument,
} from "@/lib/supabase";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { getSession } from "@/lib/auth-server";
import { applyRateLimit, documentUploadLimiter } from "@/lib/rate-limit";
import { isBookingTerminal } from "@/lib/appointments/terminal-status";
import {
  MAX_DOCS_PER_APPOINTMENT,
  MAX_DOCUMENT_BYTES,
  MAX_VERSIONS_PER_THREAD,
  resolveDocumentThreadSlot,
  validateDocumentUpload,
  withVersionConflictRetry,
} from "@/lib/documents/document-review";
import { verifyDirectUploadedObject } from "@/lib/documents/storage-verify";
import { notifyDocumentUploaded } from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { scopedHref } from "@/lib/novu/resolve-href";

const DirectCommitSchema = z.object({
  storagePath: z.string().trim().min(1),
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120),
  fileSize: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
  description: z.string().trim().max(2000).nullish(),
  responseToDocumentId: z.string().trim().min(1).nullish(),
});

const isDevelopment = () =>
  process.env.NODE_ENV === "development" &&
  process.env.DEV_BYPASS_AUTH === "true";

async function loadConsultantAppointment(
  appointmentId: string,
  userId: string,
) {
  const whereClause: Prisma.AppointmentWhereInput = { id: appointmentId };

  if (!isDevelopment()) {
    whereClause.OR = [
      {
        consultation: {
          consultationPlan: {
            consultantProfile: { user: { id: userId } },
          },
        },
      },
      {
        subscription: {
          subscriptionPlan: {
            consultantProfile: { user: { id: userId } },
          },
        },
      },
      {
        webinar: {
          webinarPlan: { consultantProfile: { user: { id: userId } } },
        },
      },
      {
        class: {
          classPlan: { consultantProfile: { user: { id: userId } } },
        },
      },
    ];
  }

  return prisma.appointment.findFirst({
    where: whereClause,
    include: {
      consultation: {
        include: {
          consultationPlan: {
            include: {
              consultantProfile: { select: { id: true, userId: true } },
            },
          },
        },
      },
      subscription: {
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: { select: { id: true, userId: true } },
            },
          },
        },
      },
      webinar: {
        include: {
          webinarPlan: {
            include: {
              consultantProfile: { select: { id: true, userId: true } },
            },
          },
        },
      },
      class: {
        include: {
          classPlan: {
            include: {
              consultantProfile: { select: { id: true, userId: true } },
            },
          },
        },
      },
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to upload documents",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const rateLimited = await applyRateLimit(
      documentUploadLimiter,
      session.user.id,
    );
    if (rateLimited) return rateLimited;

    const { appointmentId } = await params;
    const userId = session.user.id;

    const appointment = await loadConsultantAppointment(appointmentId, userId);

    if (!appointment) {
      return NextResponse.json(
        {
          error: "Access denied",
          message:
            "Appointment not found or you don't have consultant access to it",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    if (isBookingTerminal(appointment)) {
      return NextResponse.json(
        {
          error: "Document unavailable",
          message: "This appointment is no longer active.",
          code: "APPOINTMENT_TERMINAL",
        },
        { status: 403 },
      );
    }

    const consultantId =
      appointment.consultation?.consultationPlan?.consultantProfile?.id ||
      appointment.subscription?.subscriptionPlan?.consultantProfile?.id ||
      appointment.webinar?.webinarPlan?.consultantProfile?.id ||
      appointment.class?.classPlan?.consultantProfile?.id;

    if (!consultantId) {
      return NextResponse.json(
        {
          error: "Configuration error",
          message: "Could not determine consultant for this appointment",
          code: "SERVER_ERROR",
        },
        { status: 500 },
      );
    }

    const contentType = request.headers.get("content-type") ?? "";
    const isJsonCommit = contentType.includes("application/json");

    let file: File | null = null;
    let directCommitData: z.infer<typeof DirectCommitSchema> | null = null;
    let originalName = "";
    let description: string | null = null;
    let responseToDocumentId: string | null = null;

    if (isJsonCommit) {
      let rawJson: unknown;
      try {
        rawJson = await request.json();
      } catch {
        return NextResponse.json(
          {
            error: "Invalid JSON body",
            message: "Invalid upload payload.",
            code: "INVALID_INPUT",
          },
          { status: 400 },
        );
      }
      const parsed = DirectCommitSchema.safeParse(rawJson);
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: "Invalid upload metadata",
            message: "Please check your file and try uploading again.",
            code: "INVALID_INPUT",
          },
          { status: 400 },
        );
      }
      directCommitData = parsed.data;
      originalName = parsed.data.originalName;
      description = parsed.data.description?.trim() || null;
      responseToDocumentId = parsed.data.responseToDocumentId?.trim() || null;

      const validation = validateDocumentUpload({
        size: parsed.data.fileSize,
        type: parsed.data.mimeType,
      });
      if (!validation.ok) {
        return NextResponse.json(
          {
            error:
              validation.code === "FILE_TOO_LARGE"
                ? "File too large"
                : "Unsupported file type",
            message: validation.message,
            code: validation.code,
          },
          { status: 400 },
        );
      }
    } else {
      const formData = await request.formData();
      const rawFile = formData.get("file");
      file = rawFile instanceof File ? rawFile : null;
      const rawDesc = formData.get("description");
      description =
        typeof rawDesc === "string" && rawDesc.trim() ? rawDesc.trim() : null;
      const rawResp = formData.get("responseToDocumentId");
      responseToDocumentId =
        typeof rawResp === "string" && rawResp.trim() ? rawResp.trim() : null;

      if (!file) {
        return NextResponse.json(
          {
            error: "No file provided",
            message: "Please select a file to upload",
            code: "INVALID_INPUT",
          },
          { status: 400 },
        );
      }

      const validation = validateDocumentUpload(file);
      if (!validation.ok) {
        return NextResponse.json(
          {
            error:
              validation.code === "FILE_TOO_LARGE"
                ? "File too large"
                : "Unsupported file type",
            message: validation.message,
            code: validation.code,
          },
          { status: 400 },
        );
      }
      originalName = file.name;
    }

    if (
      !responseToDocumentId &&
      (await prisma.appointmentDocument.count({
        where: { appointmentId, rootDocumentId: null, deletedAt: null },
      })) >= MAX_DOCS_PER_APPOINTMENT
    ) {
      return NextResponse.json(
        {
          error: "Document limit reached",
          message: `This appointment already has ${MAX_DOCS_PER_APPOINTMENT} document threads.`,
          code: "DOCUMENT_LIMIT_REACHED",
        },
        { status: 400 },
      );
    }

    if (responseToDocumentId) {
      const parent = await prisma.appointmentDocument.findFirst({
        where: { id: responseToDocumentId, appointmentId, deletedAt: null },
        select: { id: true, rootDocumentId: true },
      });
      if (!parent) {
        return NextResponse.json(
          {
            error: "Original document not found",
            message: "The document you're responding to does not exist",
            code: "INVALID_THREAD_PARENT",
          },
          { status: 404 },
        );
      }
      const rootId = parent.rootDocumentId ?? parent.id;
      const versionCount = await prisma.appointmentDocument.count({
        where: {
          deletedAt: null,
          OR: [{ id: rootId }, { rootDocumentId: rootId }],
        },
      });
      if (versionCount >= MAX_VERSIONS_PER_THREAD) {
        return NextResponse.json(
          {
            error: "Version limit reached",
            message: `This document thread has reached the maximum of ${MAX_VERSIONS_PER_THREAD} versions.`,
            code: "VERSION_LIMIT_REACHED",
          },
          { status: 400 },
        );
      }
    }

    let resolvedStorage: {
      fileName: string;
      fileSize: number;
      mimeType: string;
      fileUrl: string;
      storagePath: string;
    };

    if (directCommitData) {
      const verified = await verifyDirectUploadedObject({
        bucket: "documents",
        storagePath: directCommitData.storagePath,
        requiredPrefix: `appointments/${appointmentId}/consultant-${consultantId}/`,
        claimedMimeType: directCommitData.mimeType,
      });
      if (!verified.ok) {
        return NextResponse.json(
          {
            error: "Upload validation failed",
            message: verified.message,
            code: verified.code,
          },
          { status: verified.code === "STORAGE_CONFIG_ERROR" ? 500 : 400 },
        );
      }
      resolvedStorage = {
        fileName: verified.fileName,
        fileSize: verified.fileSize,
        mimeType: verified.mimeType,
        fileUrl: verified.fileUrl,
        storagePath: directCommitData.storagePath,
      };
    } else {
      const uploadResult = await uploadConsultantDocument({
        appointmentId,
        consultantId,
        file: file!,
        responseToDocumentId: responseToDocumentId || undefined,
        description: description || undefined,
      });

      if (!uploadResult.success) {
        return NextResponse.json(
          {
            error: "Upload failed",
            message: uploadResult.error || "Failed to upload file",
            code: "UPLOAD_ERROR",
          },
          { status: 500 },
        );
      }

      resolvedStorage = {
        fileName: uploadResult.fileName!,
        fileSize: uploadResult.fileSize!,
        mimeType: uploadResult.mimeType!,
        fileUrl: uploadResult.fileUrl!,
        storagePath: uploadResult.storagePath!,
      };
    }

    let document;
    try {
      document = await withVersionConflictRetry(() =>
        prisma.$transaction(async (tx) => {
          const { rootDocumentId, versionNo } = await resolveDocumentThreadSlot(
            tx,
            {
              appointmentId,
              parentDocumentId: responseToDocumentId,
              maxDocsPerAppointment: MAX_DOCS_PER_APPOINTMENT,
              maxVersionsPerThread: MAX_VERSIONS_PER_THREAD,
            },
          );
          return tx.appointmentDocument.create({
            data: {
              fileName: resolvedStorage.fileName,
              originalName,
              fileSize: resolvedStorage.fileSize,
              mimeType: resolvedStorage.mimeType,
              fileUrl: resolvedStorage.fileUrl,
              storagePath: resolvedStorage.storagePath,
              description,
              uploadedByRole: "CONSULTANT",
              responseToDocumentId: responseToDocumentId || null,
              rootDocumentId,
              versionNo,
              appointmentId,
              reviewStatus: "APPROVED",
              reviewedById: userId,
              reviewedAt: new Date(),
            },
          });
        }),
      );
    } catch (dbError) {
      console.error("Database error saving consultant document:", dbError);
      Sentry.captureException(
        dbError instanceof Error ? dbError : new Error(String(dbError)),
        { tags: { subsystem: "appointments" } },
      );
      try {
        await deleteAppointmentDocument(resolvedStorage.storagePath);
      } catch (cleanupError) {
        console.error("Failed to cleanup uploaded file:", cleanupError);
      }

      if (dbError instanceof Error) {
        if (dbError.message === "INVALID_THREAD_PARENT") {
          return NextResponse.json(
            {
              error: "Original document not found",
              message: "The document you're responding to does not exist",
              code: "INVALID_THREAD_PARENT",
            },
            { status: 404 },
          );
        }
        if (dbError.message === "DOCUMENT_LIMIT_REACHED") {
          return NextResponse.json(
            {
              error: "Document limit reached",
              message: `This appointment already has ${MAX_DOCS_PER_APPOINTMENT} document threads.`,
              code: "DOCUMENT_LIMIT_REACHED",
            },
            { status: 400 },
          );
        }
        if (dbError.message === "VERSION_LIMIT_REACHED") {
          return NextResponse.json(
            {
              error: "Version limit reached",
              message: `This document thread has reached the maximum of ${MAX_VERSIONS_PER_THREAD} versions.`,
              code: "VERSION_LIMIT_REACHED",
            },
            { status: 400 },
          );
        }
      }
      return NextResponse.json(
        {
          error: "Server error",
          message: "Failed to upload document",
          code: "SERVER_ERROR",
        },
        { status: 500 },
      );
    }

    const apt = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        organizationId: true,
        consultation: {
          select: {
            requestedBy: {
              select: { id: true, user: { select: { id: true, name: true } } },
            },
          },
        },
        subscription: {
          select: {
            requestedBy: {
              select: { id: true, user: { select: { id: true, name: true } } },
            },
          },
        },
      },
    });
    const consulteeName =
      apt?.consultation?.requestedBy?.user?.name ||
      apt?.subscription?.requestedBy?.user?.name ||
      "The consultee";
    const recipientId =
      apt?.consultation?.requestedBy?.user?.id ||
      apt?.subscription?.requestedBy?.user?.id;
    const consulteeProfileId =
      apt?.consultation?.requestedBy?.id || apt?.subscription?.requestedBy?.id;

    if (recipientId) {
      after(() =>
        notifyDocumentUploaded(recipientId, {
          ...notificationScope(apt?.organizationId),
          appointmentId,
          documentId: document.id,
          uploadedByRole: "CONSULTANT",
          fileName: originalName,
          isThreaded: Boolean(responseToDocumentId),
          versionNo: document.versionNo,
          consultantName: session.user.name ?? "Your consultant",
          consulteeName,
          dashboardUrl: scopedHref({
            organizationId: apt?.organizationId,
            surface: "appointments",
            personal: consulteeProfileId
              ? { kind: "consultee", profileId: consulteeProfileId }
              : undefined,
          }),
        }).catch((notifyError) => {
          console.error("Failed to notify consultee of response", notifyError);
          Sentry.captureException(
            notifyError instanceof Error
              ? notifyError
              : new Error(String(notifyError)),
            { tags: { subsystem: "novu" } },
          );
        }),
      );
    }

    return NextResponse.json({ data: document }, { status: 201 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "appointments" } },
    );
    console.error("Error uploading consultant document:", error);
    return NextResponse.json(
      {
        error: "Server error",
        message: "Failed to upload document",
        code: "SERVER_ERROR",
      },
      { status: 500 },
    );
  }
}
