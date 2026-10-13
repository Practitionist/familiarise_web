import { NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { reportSentryMessage } from "@/lib/observability/report";
import {
  FileRouteError,
  answerFileRoute,
  fileApiError,
  parseJsonBody,
} from "@/lib/documents/api-error";
import { resolveDocumentParty } from "@/lib/documents/document-party";
import { raiseDocumentRemovalRequest } from "@/lib/documents/removal-support";
import { lockAppointment } from "@/lib/documents/upload-pipeline";

type RouteContext = {
  params: Promise<{ appointmentId: string; documentId: string }>;
};

const RemovalRequestSchema = z.object({
  note: z.string().trim().max(500).nullish(),
});

/**
 * The learner asks support to remove a document that has been reviewed (or is
 * in review). The thread root carries the flag; support removes or declines.
 */
export async function POST(request: Request, { params }: RouteContext) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user?.id) return fileApiError("UNAUTHORIZED");
    const userId = session.user.id;
    const { appointmentId, documentId } = await params;
    const { note } = await parseJsonBody(request, RemovalRequestSchema);

    const { rootId, title, requestedAt } = await prisma.$transaction(
      async (tx) => {
        await lockAppointment(tx, appointmentId);
        const party = await resolveDocumentParty(tx, appointmentId, userId);
        if (!party) throw new FileRouteError("NOT_FOUND");
        if (party.role !== "learner") throw new FileRouteError("FORBIDDEN");

        const doc = await tx.appointmentDocument.findFirst({
          where: { id: documentId, appointmentId, deletedAt: null },
          select: { id: true, rootDocumentId: true },
        });
        if (!doc) throw new FileRouteError("NOT_FOUND");
        const threadRootId = doc.rootDocumentId ?? doc.id;
        const latestLearner = await tx.appointmentDocument.findFirst({
          where: {
            deletedAt: null,
            uploadedByRole: "CONSULTEE",
            OR: [{ id: threadRootId }, { rootDocumentId: threadRootId }],
          },
          orderBy: { versionNo: "desc" },
          select: { reviewStatus: true },
        });
        if (!latestLearner || latestLearner.reviewStatus === "PENDING") {
          throw new FileRouteError("THREAD_CLOSED");
        }

        const at = new Date();
        const flagged = await tx.appointmentDocument.updateManyAndReturn({
          where: {
            id: threadRootId,
            deletedAt: null,
            uploadedByRole: "CONSULTEE",
            removalRequestedAt: null,
          },
          data: { removalRequestedAt: at },
          select: { originalName: true },
        });
        if (flagged.length === 0) {
          throw new FileRouteError("REMOVAL_ALREADY_REQUESTED");
        }
        return {
          rootId: threadRootId,
          title: flagged[0]!.originalName,
          requestedAt: at,
        };
      },
    );

    let supportThreadId: string | null = null;
    let failure: string | null = null;
    try {
      supportThreadId = await raiseDocumentRemovalRequest({
        appointmentId,
        userId,
        documentName: title,
        note: note ?? null,
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : "unknown error";
    }

    if (!supportThreadId) {
      // Without a support thread nobody would act on the flag, so it is withdrawn.
      await prisma.appointmentDocument.updateMany({
        where: { id: rootId, removalRequestedAt: requestedAt },
        data: { removalRequestedAt: null },
      });
      reportSentryMessage("Document removal request not raised in support", {
        subsystem: "documents",
        op: "removal-request",
        level: "warning",
        fingerprint: ["documents", "removal-request-support"],
        extra: {
          appointmentId,
          rootId,
          error: failure ?? "no thread",
        },
      });
      return fileApiError("SUPPORT_UNAVAILABLE");
    }

    return NextResponse.json(
      {
        removal: {
          rootId,
          requestedAt: requestedAt.toISOString(),
          supportThreadId,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  });
}
