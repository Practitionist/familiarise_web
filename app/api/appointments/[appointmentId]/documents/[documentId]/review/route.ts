import { DocumentReviewStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { applyRateLimit, documentReviewLimiter } from "@/lib/rate-limit";
import {
  FileRouteError,
  answerFileRoute,
  fileApiError,
  parseJsonBody,
} from "@/lib/documents/api-error";
import { resolveDocumentParty } from "@/lib/documents/document-party";
import {
  ThreadSlotError,
  isReviewTransitionAllowed,
  resolveDocumentThreadSlot,
  withVersionConflictRetry,
} from "@/lib/documents/document-review";
import {
  notifyDocumentAdded,
  notifyDocumentReviewOutcome,
} from "@/lib/documents/document-notify";
import {
  UploadedFileSchema,
  discardUpload,
  documentRowData,
  lockAppointment,
  requireWritableParty,
  verifyPartyUpload,
} from "@/lib/documents/upload-pipeline";

type RouteContext = {
  params: Promise<{ appointmentId: string; documentId: string }>;
};

const ReviewSchema = z
  .object({
    reviewStatus: z.nativeEnum(DocumentReviewStatus).optional(),
    reviewNotes: z.string().trim().max(2000).nullish(),
    reply: UploadedFileSchema.optional(),
  })
  .refine(
    (b) =>
      b.reviewStatus !== undefined ||
      b.reviewNotes !== undefined ||
      b.reply !== undefined,
  );

const CLOSED: ReadonlySet<DocumentReviewStatus> = new Set([
  "APPROVED",
  "REJECTED",
]);

/**
 * The expert's review of the latest learner version: a status change, notes
 * and an optional reply file, written in one transaction. A newer learner
 * version makes the review stale (SUPERSEDED).
 */
export async function POST(request: Request, { params }: RouteContext) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user?.id) return fileApiError("UNAUTHORIZED");
    const userId = session.user.id;
    const limited = await applyRateLimit(documentReviewLimiter, userId);
    if (limited) return limited;

    const { appointmentId, documentId } = await params;
    const body = await parseJsonBody(request, ReviewSchema);

    const preflight = await resolveDocumentParty(prisma, appointmentId, userId);
    if (!preflight) throw new FileRouteError("NOT_FOUND");
    if (preflight.role !== "expert") throw new FileRouteError("FORBIDDEN");
    const stored = body.reply
      ? await verifyPartyUpload(preflight, body.reply)
      : null;

    let outcome;
    try {
      outcome = await withVersionConflictRetry(() =>
        prisma.$transaction(async (tx) => {
          await lockAppointment(tx, appointmentId);
          const party = await requireWritableParty(tx, appointmentId, userId);
          if (party.role !== "expert") throw new FileRouteError("FORBIDDEN");

          const doc = await tx.appointmentDocument.findFirst({
            where: {
              id: documentId,
              appointmentId,
              deletedAt: null,
              uploadedByRole: "CONSULTEE",
            },
            select: {
              id: true,
              originalName: true,
              rootDocumentId: true,
              versionNo: true,
              reviewStatus: true,
            },
          });
          if (!doc) throw new FileRouteError("NOT_FOUND");
          const rootId = doc.rootDocumentId ?? doc.id;
          const newerLearnerVersion = {
            deletedAt: null,
            uploadedByRole: "CONSULTEE" as const,
            versionNo: { gt: doc.versionNo },
          };
          const newer = await tx.appointmentDocument.count({
            where: {
              ...newerLearnerVersion,
              OR: [{ id: rootId }, { rootDocumentId: rootId }],
            },
          });
          if (newer > 0) throw new FileRouteError("SUPERSEDED");

          const nextStatus = body.reviewStatus ?? doc.reviewStatus;
          const statusChanged = nextStatus !== doc.reviewStatus;
          if (
            statusChanged &&
            !isReviewTransitionAllowed(doc.reviewStatus, nextStatus)
          ) {
            throw new FileRouteError("INVALID_REVIEW_TRANSITION");
          }
          if (!statusChanged && CLOSED.has(doc.reviewStatus)) {
            throw new FileRouteError("THREAD_CLOSED");
          }

          const reviewed = await tx.appointmentDocument.updateMany({
            where: {
              id: doc.id,
              deletedAt: null,
              uploadedByRole: "CONSULTEE",
              reviewStatus: doc.reviewStatus,
              ...(doc.rootDocumentId
                ? {
                    rootDocument: {
                      is: { threadVersions: { none: newerLearnerVersion } },
                    },
                  }
                : { threadVersions: { none: newerLearnerVersion } }),
            },
            data: {
              ...(statusChanged && {
                reviewStatus: nextStatus,
                reviewedAt: new Date(),
                reviewedById: userId,
              }),
              ...(body.reviewNotes !== undefined && {
                reviewNotes: body.reviewNotes || null,
              }),
            },
          });
          if (reviewed.count === 0) throw new FileRouteError("SUPERSEDED");

          let reply = null;
          if (body.reply && stored) {
            const slot = await resolveDocumentThreadSlot(tx, {
              appointmentId,
              parentDocumentId: doc.id,
              uploadedByRole: "CONSULTANT",
            });
            reply = await tx.appointmentDocument.create({
              data: documentRowData({
                appointmentId,
                party,
                stored,
                storagePath: body.reply.storagePath,
                originalName: body.reply.originalName,
                description: null,
                parentDocumentId: doc.id,
                rootDocumentId: slot.rootDocumentId,
                versionNo: slot.versionNo,
              }),
              select: {
                id: true,
                originalName: true,
                versionNo: true,
                rootDocumentId: true,
              },
            });
          }
          return { party, doc, statusChanged, nextStatus, reply };
        }),
      );
    } catch (error) {
      if (body.reply) await discardUpload(body.reply.storagePath);
      if (error instanceof ThreadSlotError) {
        throw new FileRouteError(error.code);
      }
      throw error;
    }

    const { party, doc, statusChanged, nextStatus, reply } = outcome;
    if (statusChanged) {
      await notifyDocumentReviewOutcome(
        party,
        doc,
        nextStatus,
        body.reviewNotes ?? null,
      );
    } else if (reply) {
      await notifyDocumentAdded(party, reply);
    }

    return NextResponse.json(
      {
        document: { id: doc.id, reviewStatus: nextStatus },
        reply: reply ? { id: reply.id, versionNo: reply.versionNo } : null,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  });
}
