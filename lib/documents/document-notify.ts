import "server-only";

import {
  notifyDocumentReviewed,
  notifyDocumentUploaded,
} from "@/lib/novu/service";
import { stageNowAttemptAfter } from "@/lib/novu/stage-then-attempt";
import { notificationScope } from "@/lib/novu/workflows";
import type { ReviewStatus } from "./document-review";
import type { DocumentParty } from "./document-party";
import { documentsWorkspacePath } from "./urls";
import { getAppUrl } from "@/lib/url";

function workspaceUrl(
  party: DocumentParty,
  recipient: "learner" | "expert",
  threadRootId: string,
): string {
  const booking = party.booking;
  const person = recipient === "learner" ? booking.learner : booking.expert;
  return `${getAppUrl()}${documentsWorkspacePath({
    appointmentId: booking.id,
    organizationId: booking.organizationId,
    personal: {
      kind: recipient === "learner" ? "consultee" : "consultant",
      profileId: person.profileId,
    },
    threadRootId,
  })}`;
}

/** Tells the other side of the booking that a file was added. */
export async function notifyDocumentAdded(
  party: DocumentParty,
  document: {
    id: string;
    originalName: string;
    versionNo: number;
    rootDocumentId: string | null;
  },
): Promise<void> {
  const recipient = party.role === "learner" ? "expert" : "learner";
  const booking = party.booking;
  const recipientUserId =
    recipient === "expert" ? booking.expert.userId : booking.learner.userId;
  await stageNowAttemptAfter("document-upload notice", () =>
    notifyDocumentUploaded(
      recipientUserId,
      {
        ...notificationScope(booking.organizationId),
        appointmentId: booking.id,
        documentId: document.id,
        uploadedByRole: party.role === "learner" ? "CONSULTEE" : "CONSULTANT",
        fileName: document.originalName,
        isThreaded: document.rootDocumentId !== null,
        versionNo: document.versionNo,
        consultantName: booking.expert.name,
        consulteeName: booking.learner.name,
        dashboardUrl: workspaceUrl(
          party,
          recipient,
          document.rootDocumentId ?? document.id,
        ),
      },
      { deferAttempt: true },
    ),
  );
}

/** Tells the learner their version was reviewed. */
export async function notifyDocumentReviewOutcome(
  party: DocumentParty,
  document: {
    id: string;
    originalName: string;
    rootDocumentId: string | null;
  },
  reviewStatus: ReviewStatus,
  reviewNotes: string | null,
): Promise<void> {
  const booking = party.booking;
  await stageNowAttemptAfter("document-review notice", () =>
    notifyDocumentReviewed(
      booking.learner.userId,
      {
        ...notificationScope(booking.organizationId),
        appointmentId: booking.id,
        documentId: document.id,
        reviewStatus,
        reviewNotes: reviewNotes ?? undefined,
        originalName: document.originalName,
        consultantName: booking.expert.name,
        dashboardUrl: workspaceUrl(
          party,
          "learner",
          document.rootDocumentId ?? document.id,
        ),
      },
      { deferAttempt: true },
    ),
  );
}
