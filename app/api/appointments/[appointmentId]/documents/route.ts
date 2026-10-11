import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import {
  uploadAppointmentDocument,
  getManualBucketInstructions,
} from "@/lib/supabase";
import { applyRateLimit, documentUploadLimiter } from "@/lib/rate-limit";
import { isBookingTerminal } from "@/lib/appointments/terminal-status";
import { verifyDirectUploadedObject } from "@/lib/documents/storage-verify";
import {
  parseDocumentUploadInput,
  persistAppointmentDocumentWithRetry,
  preflightThreadLimits,
  type ResolvedStorageObject,
} from "@/lib/documents/upload-pipeline";
import { stageNowAttemptAfter } from "@/lib/novu/stage-then-attempt";
import { stageDocumentAndRecordingEmail } from "@/lib/email/senders/booking";
import { notifyDocumentUploaded } from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { scopedHref } from "@/lib/novu/resolve-href";

function buildFetchErrorResponse(error: unknown): NextResponse {
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

/** Lists active deliverable documents for an accessible non-terminal appointment. */
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
              user: { id: session.user.id },
            },
          },
        },
        {
          consultation: {
            consultationPlan: {
              consultantProfile: {
                user: { id: session.user.id },
              },
            },
          },
        },
        {
          subscription: {
            OR: [
              {
                requestedBy: {
                  user: { id: session.user.id },
                },
              },
              {
                subscriptionPlan: {
                  consultantProfile: {
                    user: { id: session.user.id },
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
                    user: { select: { name: true } },
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
                    user: { select: { name: true } },
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
            orderBy: { uploadedAt: "desc" },
          },
          responseToDocument: {
            select: {
              id: true,
              originalName: true,
              uploadedByRole: true,
            },
          },
        },
        orderBy: { uploadedAt: "desc" },
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
    return buildFetchErrorResponse(error);
  }
}

function mapMultipartUploadError(uploadError: unknown): NextResponse {
  console.error("File upload error:", uploadError);
  Sentry.captureException(
    uploadError instanceof Error ? uploadError : new Error(String(uploadError)),
    { tags: { subsystem: "appointments" } },
  );

  const errMsg = uploadError instanceof Error ? uploadError.message : "";
  if (errMsg.includes("network") || errMsg.includes("fetch")) {
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
  if (errMsg.includes("storage") || errMsg.includes("bucket")) {
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

async function resolveConsulteeStorageObject(params: {
  appointmentId: string;
  consulteeId: string;
  uploadInput: Extract<
    Awaited<ReturnType<typeof parseDocumentUploadInput>>,
    { ok: true }
  >;
}): Promise<
  | { ok: true; storage: ResolvedStorageObject }
  | { ok: false; response: NextResponse }
> {
  const { appointmentId, consulteeId, uploadInput } = params;

  if (uploadInput.mode === "direct") {
    const verified = await verifyDirectUploadedObject({
      bucket: "documents",
      storagePath: uploadInput.directCommitData.storagePath,
      requiredPrefix: `appointments/${appointmentId}/consultee-${consulteeId}/`,
      claimedMimeType: uploadInput.directCommitData.mimeType,
    });
    if (!verified.ok) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: "Upload validation failed",
            message: verified.message,
            code: verified.code,
          },
          { status: verified.code === "STORAGE_CONFIG_ERROR" ? 500 : 400 },
        ),
      };
    }
    return {
      ok: true,
      storage: {
        fileName: verified.fileName,
        fileSize: verified.fileSize,
        mimeType: verified.mimeType,
        fileUrl: verified.fileUrl,
        storagePath: uploadInput.directCommitData.storagePath,
      },
    };
  }

  let uploadResult;
  try {
    uploadResult = await uploadAppointmentDocument({
      appointmentId,
      consulteeId,
      description: uploadInput.description || undefined,
      file: uploadInput.file,
    });
  } catch (uploadError) {
    return { ok: false, response: mapMultipartUploadError(uploadError) };
  }

  if (!uploadResult.success) {
    const isBucketError =
      uploadResult.error?.includes("bucket") ||
      uploadResult.error?.includes("storage");

    return {
      ok: false,
      response: NextResponse.json(
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
      ),
    };
  }

  return {
    ok: true,
    storage: {
      fileName: uploadResult.fileName!,
      fileSize: uploadResult.fileSize!,
      mimeType: uploadResult.mimeType!,
      fileUrl: uploadResult.fileUrl!,
      storagePath: uploadResult.storagePath!,
    },
  };
}

/** Consultee document/revision upload endpoint delegating slot serialization to upload-pipeline. */
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

    const parsedInput = await parseDocumentUploadInput(request, {
      emptyFileCode: "NO_FILE",
    });
    if (!parsedInput.ok) return parsedInput.response;

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
            requestedBy: { user: { id: session.user.id } },
          },
        },
        {
          subscription: {
            requestedBy: { user: { id: session.user.id } },
          },
        },
      ];
    }

    const appointment = await prisma.appointment.findFirst({
      where: uploadWhereClause,
      include: {
        consultation: {
          include: {
            requestedBy: { include: { user: true } },
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: { user: { select: { id: true, name: true } } },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            requestedBy: { include: { user: true } },
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: { user: { select: { id: true, name: true } } },
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

    const preflightError = await preflightThreadLimits(
      appointmentId,
      parsedInput.responseToDocumentId,
      {
        missingParentStatus: 400,
        missingParentError: "Invalid revision target",
        missingParentMessage:
          "The document this revision replaces was not found on this appointment.",
      },
    );
    if (preflightError) return preflightError;

    const resolvedStorage = await resolveConsulteeStorageObject({
      appointmentId,
      consulteeId,
      uploadInput: parsedInput,
    });
    if (!resolvedStorage.ok) return resolvedStorage.response;

    const persisted = await persistAppointmentDocumentWithRetry({
      appointmentId,
      uploadedByRole: "CONSULTEE",
      storage: resolvedStorage.storage,
      originalName: parsedInput.originalName,
      description: parsedInput.description,
      parentDocumentId: parsedInput.responseToDocumentId,
      missingParentStatus: 400,
      missingParentError: "Invalid revision target",
      missingParentMessage:
        "The document this revision replaces was not found on this appointment.",
      fallbackErrorCode: "SAVE_FAILED",
      fallbackErrorTitle: "Save failed",
      fallbackErrorMessage:
        "The file was uploaded but couldn't be saved to your account. Please try again or contact support.",
    });
    if (!persisted.ok) return persisted.response;
    const { document } = persisted;

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
      const dashboardUrl = scopedHref({
        organizationId: appointment.organizationId,
        surface: "documents",
        personal: consultantProfileId
          ? { kind: "consultant", profileId: consultantProfileId }
          : undefined,
      });
      await stageNowAttemptAfter(
        "consultant document-upload notice",
        async () => {
          const [bell, uploadedEmails] = await Promise.all([
            Promise.resolve(
              notifyDocumentUploaded(
                consultantUserId,
                {
                  ...notificationScope(appointment.organizationId),
                  appointmentId,
                  documentId: document.id,
                  uploadedByRole: "CONSULTEE",
                  fileName: parsedInput.originalName,
                  isThreaded: Boolean(parsedInput.responseToDocumentId),
                  versionNo: document.versionNo,
                  consultantName,
                  consulteeName,
                  dashboardUrl,
                },
                { deferAttempt: true },
              ),
            ).catch(() => null),
            stageDocumentAndRecordingEmail(prisma, {
              entityId: document.id,
              userIds: [consultantUserId],
              kind: "DOCUMENT_UPLOADED",
              actorName: consulteeName,
              fileName: parsedInput.originalName,
              versionNo: document.versionNo,
              dashboardUrl,
            }).catch(() => []),
          ]);
          return {
            bells: [bell?.staged],
            emails: [{ list: uploadedEmails, emailType: "DOCUMENT_UPLOADED" }],
          };
        },
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
        message: `Successfully uploaded "${parsedInput.originalName}" for ${appointmentTitle}. ${consultantName} will review it and provide feedback.${devModeMessage}`,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Error uploading document:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "appointments" } },
    );

    if (
      error instanceof Error &&
      (error.message.includes("connect") || error.message.includes("timeout"))
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
