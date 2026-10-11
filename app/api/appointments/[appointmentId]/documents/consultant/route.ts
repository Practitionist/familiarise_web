import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse, after } from "next/server";
import prisma from "@/lib/prisma";
import { uploadConsultantDocument } from "@/lib/supabase";
import { Prisma } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
import { applyRateLimit, documentUploadLimiter } from "@/lib/rate-limit";
import { isBookingTerminal } from "@/lib/appointments/terminal-status";
import { verifyDirectUploadedObject } from "@/lib/documents/storage-verify";
import {
  parseDocumentUploadInput,
  persistAppointmentDocumentWithRetry,
  preflightThreadLimits,
  type ResolvedStorageObject,
} from "@/lib/documents/upload-pipeline";
import { notifyDocumentUploaded } from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { scopedHref } from "@/lib/novu/resolve-href";

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

async function resolveConsultantStorageObject(params: {
  appointmentId: string;
  consultantId: string;
  uploadInput: Extract<
    Awaited<ReturnType<typeof parseDocumentUploadInput>>,
    { ok: true }
  >;
}): Promise<
  | { ok: true; storage: ResolvedStorageObject }
  | { ok: false; response: NextResponse }
> {
  const { appointmentId, consultantId, uploadInput } = params;

  if (uploadInput.mode === "direct") {
    const verified = await verifyDirectUploadedObject({
      bucket: "documents",
      storagePath: uploadInput.directCommitData.storagePath,
      requiredPrefix: `appointments/${appointmentId}/consultant-${consultantId}/`,
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

  const uploadResult = await uploadConsultantDocument({
    appointmentId,
    consultantId,
    file: uploadInput.file,
    responseToDocumentId: uploadInput.responseToDocumentId || undefined,
    description: uploadInput.description || undefined,
  });

  if (!uploadResult.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Upload failed",
          message: uploadResult.error || "Failed to upload file",
          code: "UPLOAD_ERROR",
        },
        { status: 500 },
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

/** Consultant document/response upload endpoint delegating slot serialization to upload-pipeline. */
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

    const parsedInput = await parseDocumentUploadInput(request);
    if (!parsedInput.ok) return parsedInput.response;

    const preflightError = await preflightThreadLimits(
      appointmentId,
      parsedInput.responseToDocumentId,
      { missingParentStatus: 404 },
    );
    if (preflightError) return preflightError;

    const resolvedStorage = await resolveConsultantStorageObject({
      appointmentId,
      consultantId,
      uploadInput: parsedInput,
    });
    if (!resolvedStorage.ok) return resolvedStorage.response;

    const persisted = await persistAppointmentDocumentWithRetry({
      appointmentId,
      uploadedByRole: "CONSULTANT",
      reviewerUserId: userId,
      storage: resolvedStorage.storage,
      originalName: parsedInput.originalName,
      description: parsedInput.description,
      parentDocumentId: parsedInput.responseToDocumentId,
      missingParentStatus: 404,
    });
    if (!persisted.ok) return persisted.response;
    const { document } = persisted;

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
          fileName: parsedInput.originalName,
          isThreaded: Boolean(parsedInput.responseToDocumentId),
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
