import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { getSession } from "@/lib/auth-server";
import {
  uploadAppointmentDocument,
  getManualBucketInstructions,
  deleteAppointmentDocument,
} from "@/lib/supabase";
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
import { stageNowAttemptAfter } from "@/lib/novu/stage-then-attempt";
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

// GET - List documents for an appointment
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to view documents",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const { appointmentId } = await params;

    if (!appointmentId) {
      return NextResponse.json(
        {
          error: "Invalid appointment",
          message: "Appointment ID is required",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }

    const isDevelopment =
      process.env.NODE_ENV === "development" &&
      process.env.DEV_BYPASS_AUTH === "true";

    const whereClause: Prisma.AppointmentWhereInput = {
      id: appointmentId,
    };

    if (!isDevelopment) {
      whereClause.OR = [
        {
          consultation: {
            requestedBy: {
              user: {
                id: session.user.id,
              },
            },
          },
        },
        {
          consultation: {
            consultationPlan: {
              consultantProfile: {
                user: {
                  id: session.user.id,
                },
              },
            },
          },
        },
        {
          subscription: {
            OR: [
              {
                requestedBy: {
                  user: {
                    id: session.user.id,
                  },
                },
              },
              {
                subscriptionPlan: {
                  consultantProfile: {
                    user: {
                      id: session.user.id,
                    },
                  },
                },
              },
            ],
          },
        },
      ];
    }

    const appointment = await prisma.appointment.findFirst({
      where: whereClause,
      include: {
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: { name: true },
                    },
                  },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: { name: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        {
          error: "Appointment not found",
          message: isDevelopment
            ? `[DEV MODE] This appointment ID (${appointmentId}) doesn't exist in the database. Please check the appointment details.`
            : "This appointment doesn't exist or you don't have permission to view it. Please check the appointment details or contact support if you believe this is an error.",
          code: "NOT_FOUND",
        },
        { status: 404 },
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

    const appointmentTitle =
      appointment.consultation?.consultationPlan?.title ||
      appointment.subscription?.subscriptionPlan?.title ||
      "Unknown Appointment";
    const consultantName =
      appointment.consultation?.consultationPlan?.consultantProfile?.user
        ?.name ||
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user
        ?.name ||
      "Unknown Consultant";

    let documents;
    try {
      documents = await prisma.appointmentDocument.findMany({
        where: {
          appointmentId,
          deletedAt: null,
        },
        include: {
          responseDocuments: {
            where: { deletedAt: null },
            orderBy: {
              uploadedAt: "desc",
            },
          },
          responseToDocument: {
            select: {
              id: true,
              originalName: true,
              uploadedByRole: true,
            },
          },
        },
        orderBy: {
          uploadedAt: "desc",
        },
      });
    } catch (dbError) {
      console.error("Database error fetching documents:", dbError);
      Sentry.captureException(
        dbError instanceof Error ? dbError : new Error(String(dbError)),
        { tags: { subsystem: "appointments" } },
      );
      return NextResponse.json({
        data: [],
        message:
          "No documents found for this appointment yet. Upload your first document to get started!",
        appointmentTitle: isDevelopment
          ? `${appointmentTitle} [DEV MODE]`
          : appointmentTitle,
        consultantName,
      });
    }

    const devModeMessage = isDevelopment
      ? " [DEV MODE - Access control bypassed]"
      : "";

    return NextResponse.json({
      data: documents,
      count: documents.length,
      message:
        documents.length === 0
          ? `No documents uploaded yet. You can upload documents like resumes, tax returns, or other files for review.${devModeMessage}`
          : `Found ${documents.length} document${documents.length === 1 ? "" : "s"} for this appointment.${devModeMessage}`,
      appointmentTitle: isDevelopment
        ? `${appointmentTitle} [DEV MODE]`
        : appointmentTitle,
      consultantName,
    });
  } catch (error) {
    console.error("Error fetching appointment documents:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "appointments" } },
    );

    if (error instanceof Error) {
      if (
        error.message.includes("connect") ||
        error.message.includes("timeout")
      ) {
        return NextResponse.json(
          {
            error: "Connection error",
            message:
              "Unable to connect to the server. Please check your internet connection and try again.",
            code: "CONNECTION_ERROR",
          },
          { status: 503 },
        );
      }

      if (
        error.message.includes("Prisma") ||
        error.message.includes("database")
      ) {
        return NextResponse.json(
          {
            error: "Database temporarily unavailable",
            message:
              "The document system is temporarily unavailable. Please try again in a few moments.",
            code: "DATABASE_ERROR",
          },
          { status: 503 },
        );
      }
    }

    return NextResponse.json(
      {
        error: "Unable to load documents",
        message:
          "Something went wrong while loading your documents. Please refresh the page or try again later. If the problem persists, contact support.",
        code: "UNKNOWN_ERROR",
      },
      { status: 500 },
    );
  }
}

// POST - Upload a new consultee document (supports 2-phase JSON commit and multipart FormData)
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

    if (!appointmentId) {
      return NextResponse.json(
        {
          error: "Invalid appointment",
          message: "Appointment ID is required",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }

    const contentType = request.headers.get("content-type") ?? "";
    const isJsonCommit = contentType.includes("application/json");

    let file: File | null = null;
    let directCommitData: z.infer<typeof DirectCommitSchema> | null = null;
    let originalName = "";
    let description: string | null = null;
    let revisionOf: string | null = null;

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
      revisionOf = parsed.data.responseToDocumentId?.trim() || null;

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
      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        return NextResponse.json(
          {
            error: "Invalid file upload",
            message:
              "The uploaded file appears to be corrupted or invalid. Please try uploading the file again.",
            code: "INVALID_FILE",
          },
          { status: 400 },
        );
      }

      const rawFile = formData.get("file");
      file = rawFile instanceof File ? rawFile : null;
      const rawDesc = formData.get("description");
      description =
        typeof rawDesc === "string" && rawDesc.trim() ? rawDesc.trim() : null;
      const revisionOfRaw = formData.get("responseToDocumentId");
      revisionOf =
        typeof revisionOfRaw === "string" && revisionOfRaw.trim()
          ? revisionOfRaw.trim()
          : null;

      if (!file || file.size === 0) {
        return NextResponse.json(
          {
            error: "No file selected",
            message:
              "Please select a file to upload. Supported formats include PDF, Word documents, images, and text files.",
            code: "NO_FILE",
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

    const isDevelopment =
      process.env.NODE_ENV === "development" &&
      process.env.DEV_BYPASS_AUTH === "true";

    const uploadWhereClause: Prisma.AppointmentWhereInput = {
      id: appointmentId,
    };

    if (!isDevelopment) {
      uploadWhereClause.OR = [
        {
          consultation: {
            requestedBy: {
              user: {
                id: session.user.id,
              },
            },
          },
        },
        {
          subscription: {
            requestedBy: {
              user: {
                id: session.user.id,
              },
            },
          },
        },
      ];
    }

    const appointment = await prisma.appointment.findFirst({
      where: uploadWhereClause,
      include: {
        consultation: {
          include: {
            requestedBy: {
              include: {
                user: true,
              },
            },
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: { id: true, name: true },
                    },
                  },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            requestedBy: {
              include: {
                user: true,
              },
            },
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: { id: true, name: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        {
          error: "Appointment not found",
          message: isDevelopment
            ? `[DEV MODE] Appointment ${appointmentId} not found in database.`
            : "You can only upload documents to your own appointments. Please check the appointment details.",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    if (isBookingTerminal(appointment)) {
      return NextResponse.json(
        {
          error: "Booking closed",
          message:
            "Documents can no longer be uploaded to a cancelled, rejected, or expired booking.",
          code: "BOOKING_TERMINAL",
        },
        { status: 403 },
      );
    }

    const consulteeId =
      appointment.consultation?.requestedBy?.id ||
      appointment.subscription?.requestedBy?.id ||
      (isDevelopment ? session.user.id : null);

    if (!consulteeId) {
      return NextResponse.json(
        {
          error: "Invalid appointment setup",
          message:
            "There's an issue with this appointment setup. Please contact support for assistance.",
          code: "INVALID_APPOINTMENT",
        },
        { status: 400 },
      );
    }

    if (
      !revisionOf &&
      (await prisma.appointmentDocument.count({
        where: { appointmentId, rootDocumentId: null, deletedAt: null },
      })) >= MAX_DOCS_PER_APPOINTMENT
    ) {
      return NextResponse.json(
        {
          error: "Document limit reached",
          message: `This appointment already has ${MAX_DOCS_PER_APPOINTMENT} document threads. Please upload a revision to an existing thread or delete an unreviewed upload.`,
          code: "DOCUMENT_LIMIT_REACHED",
        },
        { status: 400 },
      );
    }

    if (revisionOf) {
      const parent = await prisma.appointmentDocument.findFirst({
        where: { id: revisionOf, appointmentId, deletedAt: null },
        select: { id: true, rootDocumentId: true },
      });
      if (!parent) {
        return NextResponse.json(
          {
            error: "Invalid revision target",
            message:
              "The document this revision replaces was not found on this appointment.",
            code: "INVALID_THREAD_PARENT",
          },
          { status: 400 },
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
        requiredPrefix: `appointments/${appointmentId}/consultee-${consulteeId}/`,
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
      let uploadResult;
      try {
        uploadResult = await uploadAppointmentDocument({
          appointmentId,
          consulteeId,
          description: description || undefined,
          file: file!,
        });
      } catch (uploadError) {
        console.error("File upload error:", uploadError);
        Sentry.captureException(
          uploadError instanceof Error
            ? uploadError
            : new Error(String(uploadError)),
          { tags: { subsystem: "appointments" } },
        );

        if (uploadError instanceof Error) {
          if (
            uploadError.message.includes("network") ||
            uploadError.message.includes("fetch")
          ) {
            return NextResponse.json(
              {
                error: "Network error",
                message:
                  "Upload failed due to a network issue. Please check your connection and try again.",
                code: "NETWORK_ERROR",
              },
              { status: 503 },
            );
          }

          if (
            uploadError.message.includes("storage") ||
            uploadError.message.includes("bucket")
          ) {
            return NextResponse.json(
              {
                error: "Storage error",
                message:
                  "There's a temporary issue with file storage. Please try again in a few moments.",
                code: "STORAGE_ERROR",
              },
              { status: 503 },
            );
          }
        }

        return NextResponse.json(
          {
            error: "Upload failed",
            message:
              "Failed to upload the file. Please try again or contact support if the issue persists.",
            code: "UPLOAD_ERROR",
          },
          { status: 500 },
        );
      }

      if (!uploadResult.success) {
        const isBucketError =
          uploadResult.error?.includes("bucket") ||
          uploadResult.error?.includes("storage");

        return NextResponse.json(
          {
            error: "Upload failed",
            message:
              uploadResult.error ||
              "The file upload was unsuccessful. Please try again.",
            code: isBucketError ? "BUCKET_NOT_FOUND" : "UPLOAD_FAILED",
            ...(isBucketError && {
              instructions: getManualBucketInstructions("documents"),
              technical: uploadResult.error,
            }),
          },
          { status: 400 },
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
              parentDocumentId: revisionOf,
              maxDocsPerAppointment: MAX_DOCS_PER_APPOINTMENT,
              maxVersionsPerThread: MAX_VERSIONS_PER_THREAD,
            },
          );
          return tx.appointmentDocument.create({
            data: {
              appointmentId,
              fileName: resolvedStorage.fileName,
              originalName,
              fileSize: resolvedStorage.fileSize,
              mimeType: resolvedStorage.mimeType,
              fileUrl: resolvedStorage.fileUrl,
              storagePath: resolvedStorage.storagePath,
              description,
              reviewStatus: "PENDING",
              responseToDocumentId: revisionOf,
              rootDocumentId,
              versionNo,
            },
          });
        }),
      );
    } catch (dbError) {
      console.error("Database error saving document:", dbError);
      Sentry.captureException(
        dbError instanceof Error ? dbError : new Error(String(dbError)),
        { tags: { subsystem: "appointments" } },
      );

      try {
        await deleteAppointmentDocument(resolvedStorage.storagePath);
      } catch (cleanupError) {
        console.error("Failed to cleanup uploaded file:", cleanupError);
        Sentry.captureException(
          cleanupError instanceof Error
            ? cleanupError
            : new Error(String(cleanupError)),
          { tags: { subsystem: "appointments" } },
        );
      }

      if (dbError instanceof Error) {
        if (dbError.message === "INVALID_THREAD_PARENT") {
          return NextResponse.json(
            {
              error: "Invalid revision target",
              message:
                "The document this revision replaces was not found on this appointment.",
              code: "INVALID_THREAD_PARENT",
            },
            { status: 400 },
          );
        }
        if (dbError.message === "DOCUMENT_LIMIT_REACHED") {
          return NextResponse.json(
            {
              error: "Document limit reached",
              message: `This appointment already has ${MAX_DOCS_PER_APPOINTMENT} document threads. Please upload a revision to an existing thread or delete an unreviewed upload.`,
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
          error: "Save failed",
          message:
            "The file was uploaded but couldn't be saved to your account. Please try again or contact support.",
          code: "SAVE_FAILED",
        },
        { status: 500 },
      );
    }

    const consultantUserId =
      appointment.consultation?.consultationPlan?.consultantProfile?.user?.id ||
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user?.id;
    const consultantProfileId =
      appointment.consultation?.consultationPlan?.consultantProfile?.id ||
      appointment.subscription?.subscriptionPlan?.consultantProfile?.id;
    const consulteeName =
      appointment.consultation?.requestedBy?.user?.name ||
      appointment.subscription?.requestedBy?.user?.name ||
      "The consultee";
    const consultantName =
      appointment.consultation?.consultationPlan?.consultantProfile?.user
        ?.name ||
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user
        ?.name ||
      "your consultant";

    if (consultantUserId) {
      await stageNowAttemptAfter("consultant document-upload notice", () =>
        notifyDocumentUploaded(
          consultantUserId,
          {
            ...notificationScope(appointment.organizationId),
            appointmentId,
            documentId: document.id,
            uploadedByRole: "CONSULTEE",
            fileName: originalName,
            isThreaded: Boolean(revisionOf),
            versionNo: document.versionNo,
            consultantName,
            consulteeName,
            dashboardUrl: scopedHref({
              organizationId: appointment.organizationId,
              surface: "documents",
              personal: consultantProfileId
                ? { kind: "consultant", profileId: consultantProfileId }
                : undefined,
            }),
          },
          { deferAttempt: true },
        ),
      );
    }

    const appointmentTitle =
      appointment.consultation?.consultationPlan?.title ||
      appointment.subscription?.subscriptionPlan?.title ||
      "your appointment";

    const devModeMessage = isDevelopment
      ? " [DEV MODE - Access control bypassed]"
      : "";

    return NextResponse.json(
      {
        data: document,
        message: `Successfully uploaded "${originalName}" for ${appointmentTitle}. ${consultantName} will review it and provide feedback.${devModeMessage}`,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Error uploading document:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "appointments" } },
    );

    if (error instanceof Error) {
      if (
        error.message.includes("connect") ||
        error.message.includes("timeout")
      ) {
        return NextResponse.json(
          {
            error: "Connection error",
            message:
              "Upload failed due to connection issues. Please check your internet connection and try again.",
            code: "CONNECTION_ERROR",
          },
          { status: 503 },
        );
      }
    }

    return NextResponse.json(
      {
        error: "Upload error",
        message:
          "Something went wrong during the upload. Please try again or contact support if the problem continues.",
        code: "UNKNOWN_ERROR",
      },
      { status: 500 },
    );
  }
}
