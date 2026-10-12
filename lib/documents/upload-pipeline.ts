import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { deleteAppointmentDocument } from "@/lib/supabase";
import {
  MAX_DOCS_PER_APPOINTMENT,
  MAX_DOCUMENT_BYTES,
  MAX_LEARNER_VERSIONS_PER_THREAD,
  ThreadSlotError,
  checkDocumentThreadSlot,
  resolveDocumentThreadSlot,
  validateDocumentUpload,
  withVersionConflictRetry,
  type ThreadSlotErrorCode,
} from "@/lib/documents/document-review";

/** Schema for 2-phase presigned direct upload completion payloads. */
const DirectCommitSchema = z.object({
  storagePath: z.string().trim().min(1),
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120),
  fileSize: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
  description: z.string().trim().max(2000).nullish(),
  responseToDocumentId: z.string().trim().min(1).nullish(),
});

export type DirectCommitPayload = z.infer<typeof DirectCommitSchema>;

export type ParsedUploadRequest =
  | {
      ok: true;
      mode: "direct";
      directCommitData: DirectCommitPayload;
      file: null;
      originalName: string;
      description: string | null;
      responseToDocumentId: string | null;
    }
  | {
      ok: true;
      mode: "multipart";
      directCommitData: null;
      file: File;
      originalName: string;
      description: string | null;
      responseToDocumentId: string | null;
    }
  | {
      ok: false;
      response: NextResponse;
    };

function validationFailureResponse(validation: {
  code: "FILE_TOO_LARGE" | "UNSUPPORTED_FILE_TYPE";
  message: string;
}): NextResponse {
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

/** Parses either a 2-phase presigned JSON commit body or legacy server multipart FormData. */
async function parseDirectCommitBody(
  request: NextRequest,
): Promise<ParsedUploadRequest> {
  let rawJson: unknown;
  try {
    rawJson = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Invalid JSON body",
          message: "Invalid upload payload.",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      ),
    };
  }

  const parsed = DirectCommitSchema.safeParse(rawJson);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Invalid upload metadata",
          message: "Please check your file and try uploading again.",
          code: "INVALID_INPUT",
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
    return { ok: false, response: validationFailureResponse(validation) };
  }

  return {
    ok: true,
    mode: "direct",
    directCommitData: parsed.data,
    file: null,
    originalName: parsed.data.originalName,
    description: parsed.data.description?.trim() || null,
    responseToDocumentId: parsed.data.responseToDocumentId?.trim() || null,
  };
}

export async function parseDocumentUploadInput(
  request: NextRequest,
  opts: { emptyFileCode?: "NO_FILE" | "INVALID_INPUT" } = {},
): Promise<ParsedUploadRequest> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return parseDirectCommitBody(request);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Invalid file upload",
          message:
            "The uploaded file appears to be corrupted or invalid. Please try uploading the file again.",
          code: "INVALID_FILE",
        },
        { status: 400 },
      ),
    };
  }

  const rawFile = formData.get("file");
  const file = rawFile instanceof File ? rawFile : null;
  const rawDesc = formData.get("description");
  const description =
    typeof rawDesc === "string" && rawDesc.trim() ? rawDesc.trim() : null;
  const rawResp = formData.get("responseToDocumentId");
  const responseToDocumentId =
    typeof rawResp === "string" && rawResp.trim() ? rawResp.trim() : null;

  if (!file || file.size === 0) {
    const emptyCode = opts.emptyFileCode ?? "INVALID_INPUT";
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            emptyCode === "NO_FILE" ? "No file selected" : "No file provided",
          message:
            emptyCode === "NO_FILE"
              ? "Please select a file to upload. Supported formats include PDF, Word documents, images, and text files."
              : "Please select a file to upload",
          code: emptyCode,
        },
        { status: 400 },
      ),
    };
  }

  const validation = validateDocumentUpload(file);
  if (!validation.ok) {
    return { ok: false, response: validationFailureResponse(validation) };
  }

  return {
    ok: true,
    mode: "multipart",
    directCommitData: null,
    file,
    originalName: file.name,
    description,
    responseToDocumentId,
  };
}

interface MissingParentCopy {
  missingParentStatus?: 400 | 404;
  missingParentError?: string;
  missingParentMessage?: string;
}

const THREAD_SLOT_REFUSALS: Record<
  Exclude<ThreadSlotErrorCode, "INVALID_THREAD_PARENT">,
  { status: number; error: string; message: string }
> = {
  DOCUMENT_LIMIT_REACHED: {
    status: 400,
    error: "Document limit reached",
    message: `This appointment already has ${MAX_DOCS_PER_APPOINTMENT} document threads.`,
  },
  VERSION_LIMIT_REACHED: {
    status: 409,
    error: "Version limit reached",
    message: `This document already has ${MAX_LEARNER_VERSIONS_PER_THREAD} learner versions.`,
  },
  THREAD_IN_REVIEW: {
    status: 409,
    error: "Review in progress",
    message: "The expert is reviewing the latest version.",
  },
  THREAD_CLOSED: {
    status: 409,
    error: "Document closed",
    message: "This document no longer accepts new versions.",
  },
};

function threadSlotRefusal(
  code: ThreadSlotErrorCode,
  copy: MissingParentCopy,
): NextResponse {
  if (code === "INVALID_THREAD_PARENT") {
    return NextResponse.json(
      {
        error: copy.missingParentError ?? "Original document not found",
        message:
          copy.missingParentMessage ??
          "The document you're responding to does not exist",
        code,
      },
      { status: copy.missingParentStatus ?? 404 },
    );
  }
  const refusal = THREAD_SLOT_REFUSALS[code];
  return NextResponse.json(
    { error: refusal.error, message: refusal.message, code },
    { status: refusal.status },
  );
}

/** Refuses an upload the commit transaction would refuse, before any storage write. */
export async function preflightThreadLimits(
  appointmentId: string,
  parentDocumentId: string | null | undefined,
  uploadedByRole: "CONSULTEE" | "CONSULTANT",
  copy: MissingParentCopy = {},
): Promise<NextResponse | null> {
  const outcome = await checkDocumentThreadSlot(prisma, {
    appointmentId,
    parentDocumentId,
    uploadedByRole,
  });
  return outcome.ok ? null : threadSlotRefusal(outcome.code, copy);
}

export interface ResolvedStorageObject {
  fileName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  storagePath: string;
}

/**
 * Serializes root/version slot allocation on `Appointment` (`FOR UPDATE` under `PG_POOL_MAX=1`)
 * and persists the document row, purging the storage object on transaction failure.
 */
export async function persistAppointmentDocumentWithRetry(params: {
  appointmentId: string;
  uploadedByRole: "CONSULTEE" | "CONSULTANT";
  reviewerUserId?: string;
  storage: ResolvedStorageObject;
  originalName: string;
  description: string | null;
  parentDocumentId: string | null;
  missingParentStatus?: 400 | 404;
  missingParentError?: string;
  missingParentMessage?: string;
  fallbackErrorCode?: string;
  fallbackErrorTitle?: string;
  fallbackErrorMessage?: string;
}) {
  const {
    appointmentId,
    uploadedByRole,
    reviewerUserId,
    storage,
    originalName,
    description,
    parentDocumentId,
  } = params;

  try {
    const document = await withVersionConflictRetry(() =>
      prisma.$transaction(async (tx) => {
        const { rootDocumentId, versionNo } = await resolveDocumentThreadSlot(
          tx,
          { appointmentId, parentDocumentId, uploadedByRole },
        );
        return tx.appointmentDocument.create({
          data: {
            appointmentId,
            fileName: storage.fileName,
            originalName,
            fileSize: storage.fileSize,
            mimeType: storage.mimeType,
            fileUrl: storage.fileUrl,
            storagePath: storage.storagePath,
            description,
            uploadedByRole,
            responseToDocumentId: parentDocumentId || null,
            rootDocumentId,
            versionNo,
            ...(uploadedByRole === "CONSULTANT"
              ? {
                  reviewStatus: "APPROVED",
                  reviewedById: reviewerUserId ?? null,
                  reviewedAt: new Date(),
                }
              : {
                  reviewStatus: "PENDING",
                }),
          },
        });
      }),
    );
    return { ok: true as const, document };
  } catch (dbError) {
    await deleteAppointmentDocument(storage.storagePath).catch(() => false);

    if (dbError instanceof ThreadSlotError) {
      return {
        ok: false as const,
        response: threadSlotRefusal(dbError.code, params),
      };
    }

    Sentry.captureException(
      dbError instanceof Error ? dbError : new Error(String(dbError)),
      { tags: { subsystem: "appointments" } },
    );

    return {
      ok: false as const,
      response: NextResponse.json(
        {
          error: params.fallbackErrorTitle ?? "Server error",
          message: params.fallbackErrorMessage ?? "Failed to upload document",
          code: params.fallbackErrorCode ?? "SERVER_ERROR",
        },
        { status: 500 },
      ),
    };
  }
}

/** Shared Prisma select fragment resolving consultee recipient and consultant display name for review alerts. */
export const REVIEW_NOTIFICATION_APPOINTMENT_SELECT = {
  organizationId: true,
  consultation: {
    select: {
      requestedBy: {
        select: { id: true, user: { select: { id: true } } },
      },
      consultationPlan: {
        select: {
          consultantProfile: {
            select: { user: { select: { name: true } } },
          },
        },
      },
    },
  },
  subscription: {
    select: {
      requestedBy: {
        select: { id: true, user: { select: { id: true } } },
      },
      subscriptionPlan: {
        select: {
          consultantProfile: {
            select: { user: { select: { name: true } } },
          },
        },
      },
    },
  },
} satisfies Prisma.AppointmentSelect;

export type ReviewNotificationAppointmentShape = Prisma.AppointmentGetPayload<{
  select: typeof REVIEW_NOTIFICATION_APPOINTMENT_SELECT;
}>;

/** Extracts notification target IDs and reviewer display name from an appointment snapshot. */
export function extractReviewNotificationTarget(
  appointment: ReviewNotificationAppointmentShape | null | undefined,
): {
  organizationId: string | null;
  recipientId: string | undefined;
  consulteeProfileId: string | undefined;
  reviewerName: string;
} {
  return {
    organizationId: appointment?.organizationId ?? null,
    recipientId:
      appointment?.consultation?.requestedBy?.user?.id ||
      appointment?.subscription?.requestedBy?.user?.id,
    consulteeProfileId:
      appointment?.consultation?.requestedBy?.id ||
      appointment?.subscription?.requestedBy?.id,
    reviewerName:
      appointment?.consultation?.consultationPlan?.consultantProfile?.user
        ?.name ||
      appointment?.subscription?.subscriptionPlan?.consultantProfile?.user
        ?.name ||
      "The consultant",
  };
}
