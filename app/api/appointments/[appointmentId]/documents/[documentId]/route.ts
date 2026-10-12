import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  DocumentReviewStatus,
  Prisma,
  type AppointmentDocument,
} from "@prisma/client";
import { z } from "zod";

import { getSession } from "@/lib/auth-server";
import type { Session } from "@/lib/auth";
import { applyRateLimit, documentReviewLimiter } from "@/lib/rate-limit";
import {
  isReviewTransitionAllowed,
  type ReviewStatus,
} from "@/lib/documents/document-review";
import {
  extractReviewNotificationTarget,
  REVIEW_NOTIFICATION_APPOINTMENT_SELECT,
} from "@/lib/documents/upload-pipeline";
import { stageNowAttemptAfter } from "@/lib/novu/stage-then-attempt";
import { notifyDocumentReviewed } from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { scopedHref } from "@/lib/novu/resolve-href";

const TERMINAL_BOOKING_STATUSES = new Set(["CANCELLED", "REJECTED", "EXPIRED"]);

function isAppointmentTerminal(appointment: {
  consultation?: { status: string } | null;
  subscription?: { status: string } | null;
}): boolean {
  if (appointment.consultation) {
    return TERMINAL_BOOKING_STATUSES.has(appointment.consultation.status);
  }
  if (appointment.subscription) {
    return TERMINAL_BOOKING_STATUSES.has(appointment.subscription.status);
  }
  return false;
}

async function resolveAppointmentDocumentForView(
  params: Promise<{ appointmentId: string; documentId: string }>,
): Promise<
  | {
      session: Session;
      appointmentId: string;
      documentId: string;
      document: AppointmentDocument;
      isDevelopment: boolean;
      error?: never;
    }
  | {
      session?: never;
      appointmentId?: never;
      documentId?: never;
      document?: never;
      isDevelopment?: never;
      error: NextResponse;
    }
> {
  const session = await getSession();
  if (!session?.user?.id) {
    return {
      error: NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to view documents",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      ),
    };
  }

  const { appointmentId, documentId } = await params;

  const isDevelopment =
    process.env.NODE_ENV === "development" &&
    process.env.DEV_BYPASS_AUTH === "true";

  const whereClause: Prisma.AppointmentDocumentWhereInput = {
    id: documentId,
    appointmentId,
    deletedAt: null,
  };

  if (!isDevelopment) {
    const userId = session.user.id;
    whereClause.appointment = {
      OR: [
        {
          consultation: {
            requestedBy: { user: { id: userId } },
          },
        },
        {
          subscription: {
            requestedBy: { user: { id: userId } },
          },
        },
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
      ],
    };
  }

  const document = await prisma.appointmentDocument.findFirst({
    where: whereClause,
  });

  if (!document) {
    return {
      error: NextResponse.json(
        {
          error: "Document not found",
          message: "Document not found or access denied",
          code: "NOT_FOUND",
        },
        { status: 404 },
      ),
    };
  }

  return { session, appointmentId, documentId, document, isDevelopment };
}

export async function GET(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ appointmentId: string; documentId: string }> },
) {
  try {
    const { document, error: accessError } =
      await resolveAppointmentDocumentForView(params);
    if (accessError) return accessError;

    return NextResponse.json({ data: document });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "appointments" } },
    );
    console.error("Error fetching document:", error);
    return NextResponse.json(
      { error: "Failed to fetch document" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ appointmentId: string; documentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to review documents",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const { appointmentId, documentId } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    const rateLimited = await applyRateLimit(
      documentReviewLimiter,
      session.user.id,
    );
    if (rateLimited) return rateLimited;

    const isDevelopment =
      process.env.NODE_ENV === "development" &&
      process.env.DEV_BYPASS_AUTH === "true";

    const whereClause: Prisma.AppointmentDocumentWhereInput = {
      id: documentId,
      appointmentId,
      deletedAt: null,
      uploadedByRole: "CONSULTEE",
    };

    if (!isDevelopment) {
      whereClause.appointment = {
        OR: [
          {
            consultation: {
              consultationPlan: {
                consultantProfile: { user: { id: session.user.id } },
              },
            },
          },
          {
            subscription: {
              subscriptionPlan: {
                consultantProfile: { user: { id: session.user.id } },
              },
            },
          },
        ],
      };
    }

    const document = await prisma.appointmentDocument.findFirst({
      where: whereClause,
      include: {
        appointment: {
          select: {
            consultation: { select: { status: true } },
            subscription: { select: { status: true } },
          },
        },
      },
    });

    if (!document) {
      return NextResponse.json(
        {
          error: "Document not found",
          message: "Document not found or access denied",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    if (document.appointment && isAppointmentTerminal(document.appointment)) {
      return NextResponse.json(
        {
          error: "Appointment closed",
          message: "Documents on a closed appointment cannot be reviewed.",
          code: "APPOINTMENT_TERMINAL",
        },
        { status: 409 },
      );
    }

    const patchSchema = z.object({
      reviewStatus: z.nativeEnum(DocumentReviewStatus).optional(),
      reviewNotes: z.string().trim().max(2000).nullish(),
    });
    const parsedPatch = patchSchema.safeParse(body);
    if (!parsedPatch.success) {
      return NextResponse.json(
        {
          error: "Invalid review payload",
          details: parsedPatch.error.flatten(),
        },
        { status: 400 },
      );
    }

    const { reviewStatus: validStatus, reviewNotes: validNotes } =
      parsedPatch.data;

    const statusChanged = Boolean(
      validStatus && validStatus !== document.reviewStatus,
    );

    if (
      statusChanged &&
      validStatus &&
      !isReviewTransitionAllowed(
        document.reviewStatus as ReviewStatus,
        validStatus as ReviewStatus,
      )
    ) {
      return NextResponse.json(
        {
          error: "Invalid transition",
          message: `A ${document.reviewStatus.toLowerCase()} document can no longer move to ${validStatus}. Upload or request a threaded revision instead.`,
          code: "INVALID_REVIEW_TRANSITION",
        },
        { status: 409 },
      );
    }

    // A review only lands on the newest live learner version of its thread.
    const newerLearnerVersion = {
      deletedAt: null,
      uploadedByRole: "CONSULTEE" as const,
      versionNo: { gt: document.versionNo },
    };
    const rootId = document.rootDocumentId ?? document.id;
    const casResult = await prisma.appointmentDocument.updateMany({
      where: {
        id: documentId,
        appointmentId,
        deletedAt: null,
        uploadedByRole: "CONSULTEE",
        reviewStatus: document.reviewStatus,
        ...(document.rootDocumentId
          ? {
              rootDocument: {
                is: { threadVersions: { none: newerLearnerVersion } },
              },
            }
          : { threadVersions: { none: newerLearnerVersion } }),
      },
      data: {
        ...(statusChanged && validStatus && { reviewStatus: validStatus }),
        ...(validNotes !== undefined && {
          reviewNotes: validNotes === "" ? null : validNotes,
        }),
        ...(statusChanged && { reviewedAt: new Date() }),
        ...(statusChanged && { reviewedById: session.user.id }),
      },
    });

    if (casResult.count === 0) {
      const superseded = await prisma.appointmentDocument.count({
        where: { rootDocumentId: rootId, ...newerLearnerVersion },
      });
      if (superseded > 0) {
        return NextResponse.json(
          {
            error: "Newer version uploaded",
            message: "The learner uploaded a newer version of this document.",
            code: "SUPERSEDED",
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        {
          error: "Concurrent review update",
          message:
            "This document's review state changed concurrently. Refresh and try again.",
          code: "CONCURRENT_REVIEW_CONFLICT",
        },
        { status: 409 },
      );
    }

    const updatedDocument = await prisma.appointmentDocument.findUniqueOrThrow({
      where: { id: documentId },
    });

    if (statusChanged && validStatus) {
      const appointmentInfo = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        select: REVIEW_NOTIFICATION_APPOINTMENT_SELECT,
      });
      const target = extractReviewNotificationTarget(appointmentInfo);

      if (target.recipientId) {
        const recipientId = target.recipientId;
        await stageNowAttemptAfter("consultee document-review notice", () =>
          notifyDocumentReviewed(
            recipientId,
            {
              ...notificationScope(target.organizationId),
              appointmentId,
              documentId,
              reviewStatus: validStatus as ReviewStatus,
              reviewNotes: validNotes || undefined,
              originalName: document.originalName,
              consultantName: target.reviewerName,
              dashboardUrl: scopedHref({
                organizationId: target.organizationId,
                surface: "appointments",
                personal: target.consulteeProfileId
                  ? {
                      kind: "consultee",
                      profileId: target.consulteeProfileId,
                    }
                  : undefined,
              }),
            },
            { deferAttempt: true },
          ),
        );
      }
    }

    return NextResponse.json({ data: updatedDocument });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "appointments" } },
    );
    console.error("Error updating document review:", error);
    return NextResponse.json(
      { error: "Failed to update document review" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ appointmentId: string; documentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to delete documents",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const { appointmentId, documentId } = await params;
    const isDevelopment =
      process.env.NODE_ENV === "development" &&
      process.env.DEV_BYPASS_AUTH === "true";

    const existingDoc = await prisma.appointmentDocument.findFirst({
      where: {
        id: documentId,
        appointmentId,
        deletedAt: null,
        ...(!isDevelopment && {
          appointment: {
            OR: [
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
              {
                consultation: {
                  consultationPlan: {
                    consultantProfile: { user: { id: session.user.id } },
                  },
                },
              },
              {
                subscription: {
                  subscriptionPlan: {
                    consultantProfile: { user: { id: session.user.id } },
                  },
                },
              },
            ],
          },
        }),
      },
      include: {
        appointment: {
          select: {
            consultation: {
              select: {
                consultationPlan: {
                  select: {
                    consultantProfile: { select: { userId: true } },
                  },
                },
              },
            },
            subscription: {
              select: {
                subscriptionPlan: {
                  select: {
                    consultantProfile: { select: { userId: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!existingDoc) {
      return NextResponse.json(
        {
          error: "Document not found",
          message: "Document not found or access denied",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    const consultantUserId =
      existingDoc.appointment?.consultation?.consultationPlan?.consultantProfile
        ?.userId ??
      existingDoc.appointment?.subscription?.subscriptionPlan?.consultantProfile
        ?.userId ??
      null;
    const isConsultant = consultantUserId === session.user.id;

    if (isConsultant && existingDoc.uploadedByRole === "CONSULTANT") {
      const result = await prisma.appointmentDocument.updateMany({
        where: {
          id: documentId,
          appointmentId,
          uploadedByRole: "CONSULTANT",
          rootDocumentId: null,
          deletedAt: null,
        },
        data: {
          deletedAt: new Date(),
          deletedById: session.user.id,
        },
      });

      if (result.count === 0) {
        return NextResponse.json(
          {
            error: "Conflict",
            message: "Only standalone consultant handouts can be deleted",
            code: "DOCUMENT_NOT_DELETABLE",
          },
          { status: 409 },
        );
      }

      return NextResponse.json({ message: "Document deleted successfully" });
    }

    const result = await prisma.appointmentDocument.updateMany({
      where: {
        id: documentId,
        appointmentId,
        uploadedByRole: "CONSULTEE",
        reviewStatus: "PENDING",
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
        deletedById: session.user.id,
      },
    });

    if (result.count === 0) {
      return NextResponse.json(
        {
          error: "Conflict",
          message: "Only unreviewed pending submissions can be deleted",
          code: "DOCUMENT_NOT_DELETABLE",
        },
        { status: 409 },
      );
    }

    return NextResponse.json({ message: "Document deleted successfully" });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "appointments" } },
    );
    console.error("Error deleting document:", error);
    return NextResponse.json(
      { error: "Failed to delete document" },
      { status: 500 },
    );
  }
}
