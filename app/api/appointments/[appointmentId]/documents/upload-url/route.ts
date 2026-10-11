import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { applyRateLimit, documentUploadLimiter } from "@/lib/rate-limit";
import { isBookingTerminal } from "@/lib/appointments/terminal-status";
import {
  generateStorageFileName,
  supabaseAdmin,
} from "@/lib/supabase-storage-core";
import {
  MAX_DOCUMENT_BYTES,
  validateDocumentUpload,
} from "@/lib/documents/document-review";
import { preflightThreadLimits } from "@/lib/documents/upload-pipeline";

const UploadUrlRequestSchema = z.object({
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120),
  fileSize: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
  responseToDocumentId: z.string().trim().min(1).optional(),
});

async function parseUploadUrlBody(request: NextRequest): Promise<
  | {
      ok: true;
      data: z.infer<typeof UploadUrlRequestSchema>;
    }
  | {
      ok: false;
      response: NextResponse;
    }
> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Invalid JSON body",
          message: "Please provide valid upload metadata.",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      ),
    };
  }

  const parsed = UploadUrlRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Invalid upload request",
          message: `File size must be between 1 byte and ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)}MB.`,
          code: "INVALID_INPUT",
          details: parsed.error.flatten(),
        },
        { status: 400 },
      ),
    };
  }

  const validation = validateDocumentUpload({
    size: parsed.data.fileSize,
    type: parsed.data.mimeType,
  });
  if (!validation.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            validation.code === "FILE_TOO_LARGE"
              ? "File too large"
              : "Unsupported file type",
          message: validation.message,
          code: validation.code,
        },
        { status: 400 },
      ),
    };
  }

  return { ok: true, data: parsed.data };
}

async function loadUploadTargetAppointment(
  appointmentId: string,
  userId: string,
) {
  const isDevelopment =
    process.env.NODE_ENV === "development" &&
    process.env.DEV_BYPASS_AUTH === "true";

  const appointmentWhere: Prisma.AppointmentWhereInput = { id: appointmentId };
  if (!isDevelopment) {
    appointmentWhere.OR = [
      { consultation: { requestedBy: { user: { id: userId } } } },
      {
        consultation: {
          consultationPlan: { consultantProfile: { user: { id: userId } } },
        },
      },
      { subscription: { requestedBy: { user: { id: userId } } } },
      {
        subscription: {
          subscriptionPlan: { consultantProfile: { user: { id: userId } } },
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
    where: appointmentWhere,
    include: {
      consultation: {
        select: {
          status: true,
          requestedBy: { select: { id: true, userId: true } },
          consultationPlan: {
            select: {
              consultantProfile: { select: { id: true, userId: true } },
            },
          },
        },
      },
      subscription: {
        select: {
          status: true,
          requestedBy: { select: { id: true, userId: true } },
          subscriptionPlan: {
            select: {
              consultantProfile: { select: { id: true, userId: true } },
            },
          },
        },
      },
      webinar: {
        select: {
          status: true,
          webinarPlan: {
            select: {
              consultantProfile: { select: { id: true, userId: true } },
            },
          },
        },
      },
      class: {
        select: {
          status: true,
          classPlan: {
            select: {
              consultantProfile: { select: { id: true, userId: true } },
            },
          },
        },
      },
    },
  });
}

/** Mints single-use presigned Supabase upload URLs (`upsert: false`) so clients bypass the 6 MB Lambda body limit. */
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

    const parsedBody = await parseUploadUrlBody(request);
    if (!parsedBody.ok) return parsedBody.response;
    const { mimeType, responseToDocumentId } = parsedBody.data;

    const userId = session.user.id;
    const appointment = await loadUploadTargetAppointment(
      appointmentId,
      userId,
    );
    if (!appointment) {
      return NextResponse.json(
        {
          error: "Appointment not found",
          message: "You do not have permission to upload to this appointment.",
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

    const preflightError = await preflightThreadLimits(
      appointmentId,
      responseToDocumentId,
      { missingParentStatus: 404 },
    );
    if (preflightError) return preflightError;

    if (!supabaseAdmin) {
      return NextResponse.json(
        {
          error: "Storage configuration error",
          message: "Document storage is not configured on the server.",
          code: "STORAGE_CONFIG_ERROR",
        },
        { status: 500 },
      );
    }

    const consultantProfile =
      appointment.consultation?.consultationPlan?.consultantProfile ||
      appointment.subscription?.subscriptionPlan?.consultantProfile ||
      appointment.webinar?.webinarPlan?.consultantProfile ||
      appointment.class?.classPlan?.consultantProfile;

    const isConsultantUploader = consultantProfile?.userId === userId;
    const consulteeProfileId =
      appointment.consultation?.requestedBy?.id ||
      appointment.subscription?.requestedBy?.id ||
      userId;

    const folderPrefix = isConsultantUploader
      ? `appointments/${appointmentId}/consultant-${consultantProfile?.id}`
      : `appointments/${appointmentId}/consultee-${consulteeProfileId}`;
    const generatedName = generateStorageFileName(mimeType);
    const storagePath = `${folderPrefix}/${generatedName}`;

    const { data, error } = await supabaseAdmin.storage
      .from("documents")
      .createSignedUploadUrl(storagePath, { upsert: false });

    if (error || !data?.signedUrl) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "storage" } },
      );
      return NextResponse.json(
        {
          error: "Upload initialization failed",
          message: "Unable to create upload URL right now. Please try again.",
          code: "UPLOAD_URL_FAILED",
        },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        uploadUrl: data.signedUrl,
        token: data.token,
        storagePath,
      },
      { status: 200 },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "appointments" } },
    );
    return NextResponse.json(
      {
        error: "Server error",
        message: "Failed to initialize document upload.",
        code: "SERVER_ERROR",
      },
      { status: 500 },
    );
  }
}
