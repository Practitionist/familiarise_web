import { NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import {
  FileRouteError,
  answerFileRoute,
  fileApiError,
} from "@/lib/documents/api-error";
import {
  lockAppointment,
  requireWritableParty,
} from "@/lib/documents/upload-pipeline";

type RouteContext = {
  params: Promise<{ appointmentId: string; documentId: string }>;
};

/**
 * A learner withdraws the latest version of a thread while it still waits for
 * review; an expert deletes a file they shared. Anything else is refused.
 */
export async function DELETE(_request: Request, { params }: RouteContext) {
  return answerFileRoute(async () => {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const userId = auth.session.user.id;
    const { appointmentId, documentId } = await params;

    await prisma.$transaction(async (tx) => {
      await lockAppointment(tx, appointmentId);
      const party = await requireWritableParty(tx, appointmentId, userId);
      const tombstone = {
        deletedAt: new Date(),
        deletedById: userId,
        removalReason: "USER_REQUEST" as const,
      };

      if (party.role === "learner") {
        const doc = await tx.appointmentDocument.findFirst({
          where: { id: documentId, appointmentId, deletedAt: null },
          select: { rootDocumentId: true, versionNo: true },
        });
        if (!doc) throw new FileRouteError("NOT_FOUND");
        const noNewerVersion = doc.rootDocumentId
          ? {
              rootDocument: {
                is: {
                  threadVersions: {
                    none: {
                      deletedAt: null,
                      versionNo: { gt: doc.versionNo },
                    },
                  },
                },
              },
            }
          : { threadVersions: { none: { deletedAt: null } } };
        const withdrawn = await tx.appointmentDocument.updateMany({
          where: {
            id: documentId,
            appointmentId,
            deletedAt: null,
            uploadedByRole: "CONSULTEE",
            reviewStatus: "PENDING",
            ...noNewerVersion,
          },
          data: tombstone,
        });
        if (withdrawn.count === 0) {
          throw new FileRouteError("DOCUMENT_NOT_DELETABLE");
        }
        return;
      }

      const removed = await tx.appointmentDocument.updateMany({
        where: {
          id: documentId,
          appointmentId,
          deletedAt: null,
          uploadedByRole: "CONSULTANT",
          rootDocumentId: null,
        },
        data: tombstone,
      });
      if (removed.count === 0) {
        throw new FileRouteError("DOCUMENT_NOT_DELETABLE");
      }
      await tx.appointmentDocument.updateMany({
        where: { rootDocumentId: documentId, deletedAt: null },
        data: tombstone,
      });
    });

    return NextResponse.json(
      { removed: true },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  });
}
