import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DocumentReviewStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { getSession } from "@/lib/auth-server";
import { applyRateLimit, documentReviewLimiter } from "@/lib/rate-limit";
import { stageNowAttemptAfter } from "@/lib/novu/stage-then-attempt";
import { notifyDocumentReviewed } from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { scopedHref } from "@/lib/novu/resolve-href";
import type { ReviewStatus } from "@/lib/documents/document-review";

const MAX_BULK = 100;
const MAX_NOTES = 2000;

const BulkReviewSchema = z.object({
  documentIds: z.array(z.string().min(1)).min(1).max(MAX_BULK),
  reviewStatus: z.nativeEnum(DocumentReviewStatus),
  reviewNotes: z.string().trim().max(MAX_NOTES).nullish(),
});

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required", code: "UNAUTHORIZED" },
        { status: 401 },
      );
    }

    const limited = await applyRateLimit(
      documentReviewLimiter,
      session.user.id,
    );
    if (limited) return limited;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    const parsed = BulkReviewSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid input",
          details: parsed.error.issues,
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }
    const { documentIds, reviewStatus, reviewNotes } = parsed.data;

    const ownedByConsultant: Prisma.AppointmentWhereInput = {
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
        {
          trial: {
            subscriptionPlan: {
              consultantProfile: { user: { id: session.user.id } },
            },
          },
        },
      ],
    };

    const eligibleWhere: Prisma.AppointmentDocumentWhereInput = {
      id: { in: documentIds },
      deletedAt: null,
      reviewStatus: {
        in: [
          DocumentReviewStatus.PENDING,
          DocumentReviewStatus.IN_REVIEW,
          DocumentReviewStatus.NEEDS_REVISION,
        ],
      },
      appointment: ownedByConsultant,
    };

    const { targetDocs, result } = await prisma.$transaction(async (tx) => {
      const docs = await tx.appointmentDocument.findMany({
        where: eligibleWhere,
        select: {
          id: true,
          appointmentId: true,
          originalName: true,
          appointment: {
            select: {
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
              trial: {
                select: {
                  consulteeProfile: {
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
            },
          },
        },
      });

      const targetIds = docs.map((doc) => doc.id);
      const updated = await tx.appointmentDocument.updateMany({
        where: { ...eligibleWhere, id: { in: targetIds } },
        data: {
          reviewStatus,
          ...(reviewNotes ? { reviewNotes } : {}),
          reviewedAt: new Date(),
          reviewedById: session.user.id,
        },
      });
      return { targetDocs: docs, result: updated };
    });

    if (targetDocs.length > 0) {
      await stageNowAttemptAfter(
        "bulk consultee document-review notices",
        async () => {
          const results = await Promise.all(
            targetDocs.map((doc) => {
              const recipientId =
                doc.appointment.consultation?.requestedBy?.user?.id ||
                doc.appointment.subscription?.requestedBy?.user?.id ||
                doc.appointment.trial?.consulteeProfile?.user?.id;
              const consulteeProfileId =
                doc.appointment.consultation?.requestedBy?.id ||
                doc.appointment.subscription?.requestedBy?.id ||
                doc.appointment.trial?.consulteeProfile?.id;
              const reviewerName =
                doc.appointment.consultation?.consultationPlan
                  ?.consultantProfile?.user?.name ||
                doc.appointment.subscription?.subscriptionPlan
                  ?.consultantProfile?.user?.name ||
                doc.appointment.trial?.subscriptionPlan?.consultantProfile?.user
                  ?.name ||
                "The consultant";

              if (!recipientId) return null;
              return notifyDocumentReviewed(
                recipientId,
                {
                  ...notificationScope(doc.appointment.organizationId),
                  appointmentId: doc.appointmentId,
                  documentId: doc.id,
                  reviewStatus: reviewStatus as ReviewStatus,
                  reviewNotes: reviewNotes || undefined,
                  originalName: doc.originalName,
                  consultantName: reviewerName,
                  dashboardUrl: scopedHref({
                    organizationId: doc.appointment.organizationId,
                    surface: "appointments",
                    personal: consulteeProfileId
                      ? { kind: "consultee", profileId: consulteeProfileId }
                      : undefined,
                  }),
                },
                { deferAttempt: true },
              );
            }),
          );
          return results.filter((r): r is NonNullable<typeof r> => r !== null);
        },
      );
    }

    return NextResponse.json({
      data: { updated: result.count, requested: documentIds.length },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "documents" } },
    );
    console.error("Error in bulk document review:", error);
    return NextResponse.json(
      { error: "Failed to review documents", code: "SERVER_ERROR" },
      { status: 500 },
    );
  }
}
