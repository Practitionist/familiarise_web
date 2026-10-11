import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DocumentReviewStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { getSession } from "@/lib/auth-server";
import { applyRateLimit, documentReviewLimiter } from "@/lib/rate-limit";
import { stageNowAttemptAfter } from "@/lib/novu/stage-then-attempt";
import { stageDocumentAndRecordingEmail } from "@/lib/email/senders/booking";
import { notifyDocumentReviewed } from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { scopedHref } from "@/lib/novu/resolve-href";
import type { ReviewStatus } from "@/lib/documents/document-review";
import {
  extractReviewNotificationTarget,
  REVIEW_NOTIFICATION_APPOINTMENT_SELECT,
} from "@/lib/documents/upload-pipeline";

const MAX_BULK = 100;
const MAX_NOTES = 2000;

const BulkReviewSchema = z.object({
  documentIds: z.array(z.string().min(1)).min(1).max(MAX_BULK),
  reviewStatus: z.nativeEnum(DocumentReviewStatus),
  reviewNotes: z.string().trim().max(MAX_NOTES).nullish(),
});

const NON_TERMINAL_REVIEW_STATUSES: DocumentReviewStatus[] = [
  DocumentReviewStatus.PENDING,
  DocumentReviewStatus.IN_REVIEW,
  DocumentReviewStatus.NEEDS_REVISION,
];

/**
 * Bulk document review endpoint using conditional `updateManyAndReturn` CAS-in-WHERE
 * (`reviewStatus: { in: statusTransitionSources }`, `deletedAt: null`, `uploadedByRole: "CONSULTEE"`).
 */
export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession();
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

    const ownedNonTerminalAppointment: Prisma.AppointmentWhereInput = {
      OR: [
        {
          consultation: {
            consultationPlan: {
              consultantProfile: { user: { id: session.user.id } },
            },
            status: { notIn: ["CANCELLED", "REJECTED", "EXPIRED"] },
          },
        },
        {
          subscription: {
            subscriptionPlan: {
              consultantProfile: { user: { id: session.user.id } },
            },
            status: { notIn: ["CANCELLED", "REJECTED", "EXPIRED"] },
          },
        },
      ],
    };

    const statusTransitionSources = NON_TERMINAL_REVIEW_STATUSES.filter(
      (s) => s !== reviewStatus,
    );

    const { targetDocs, totalUpdated } = await prisma.$transaction(
      async (tx) => {
        const updatedRows = await tx.appointmentDocument.updateManyAndReturn({
          where: {
            id: { in: documentIds },
            deletedAt: null,
            uploadedByRole: "CONSULTEE",
            reviewStatus: { in: statusTransitionSources },
            appointment: ownedNonTerminalAppointment,
          },
          data: {
            reviewStatus,
            ...(reviewNotes !== undefined && {
              reviewNotes: reviewNotes === "" ? null : reviewNotes,
            }),
            reviewedAt: new Date(),
            reviewedById: session.user.id,
          },
          select: {
            id: true,
            appointmentId: true,
            originalName: true,
            appointment: { select: REVIEW_NOTIFICATION_APPOINTMENT_SELECT },
          },
        });

        let sameStatusCount = 0;
        if (
          reviewNotes !== undefined &&
          NON_TERMINAL_REVIEW_STATUSES.includes(reviewStatus)
        ) {
          const notesOnlyRes = await tx.appointmentDocument.updateMany({
            where: {
              id: { in: documentIds },
              deletedAt: null,
              uploadedByRole: "CONSULTEE",
              reviewStatus,
              appointment: ownedNonTerminalAppointment,
            },
            data: {
              reviewNotes: reviewNotes === "" ? null : reviewNotes,
            },
          });
          sameStatusCount = notesOnlyRes.count;
        }

        return {
          targetDocs: updatedRows,
          totalUpdated: updatedRows.length + sameStatusCount,
        };
      },
    );

    if (targetDocs.length > 0) {
      await stageNowAttemptAfter(
        "bulk consultee document-review notices",
        async () => {
          const perDoc = await Promise.all(
            targetDocs.map(async (doc) => {
              const target = extractReviewNotificationTarget(doc.appointment);
              if (!target.recipientId) return null;
              const dashboardUrl = scopedHref({
                organizationId: target.organizationId,
                surface: "appointments",
                personal: target.consulteeProfileId
                  ? {
                      kind: "consultee",
                      profileId: target.consulteeProfileId,
                    }
                  : undefined,
              });
              const [bell, docEmails] = await Promise.all([
                notifyDocumentReviewed(
                  target.recipientId,
                  {
                    ...notificationScope(target.organizationId),
                    appointmentId: doc.appointmentId,
                    documentId: doc.id,
                    reviewStatus: reviewStatus as ReviewStatus,
                    reviewNotes: reviewNotes || undefined,
                    originalName: doc.originalName,
                    consultantName: target.reviewerName,
                    dashboardUrl,
                  },
                  { deferAttempt: true },
                ),
                stageDocumentAndRecordingEmail(prisma, {
                  entityId: doc.id,
                  userIds: [target.recipientId],
                  kind: "DOCUMENT_REVIEWED",
                  actorName: target.reviewerName,
                  fileName: doc.originalName,
                  reviewStatus,
                  reviewNotes: reviewNotes ?? null,
                  dashboardUrl,
                }).catch(() => []),
              ]);
              return { bell: bell?.staged, emails: docEmails };
            }),
          );
          const valid = perDoc.filter(
            (item): item is NonNullable<typeof item> => item !== null,
          );
          return {
            bells: valid.map((item) => item.bell),
            emails: [
              {
                list: valid.flatMap((item) => item.emails),
                emailType: "DOCUMENT_REVIEWED",
              },
            ],
          };
        },
      );
    }

    return NextResponse.json({
      data: { updated: totalUpdated, requested: documentIds.length },
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
