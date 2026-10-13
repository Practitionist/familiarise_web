import "server-only";

import {
  notifyDocumentReviewed,
  notifyDocumentUploaded,
} from "@/lib/novu/service";
import {
  stageNowAttemptAfter,
  type StagedNotificationBundle,
} from "@/lib/novu/stage-then-attempt";
import type { TriggerResult } from "@/lib/novu/outbox";
import {
  stageDocumentAndRecordingEmail,
  type DocumentAndRecordingEmailArgs,
} from "@/lib/email/senders/booking";
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

/** Stages the bell and the email together; one channel failing never drops the other. */
async function stageBellAndEmail(
  bell: () => Promise<TriggerResult>,
  email: DocumentAndRecordingEmailArgs,
): Promise<StagedNotificationBundle> {
  const [bellOutcome, emailOutcome] = await Promise.allSettled([
    bell(),
    stageDocumentAndRecordingEmail(email),
  ]);
  if (bellOutcome.status === "rejected" && emailOutcome.status === "rejected") {
    throw bellOutcome.reason;
  }
  return {
    bells: [
      bellOutcome.status === "fulfilled" ? bellOutcome.value.staged : null,
    ],
    emails: [
      {
        list: emailOutcome.status === "fulfilled" ? emailOutcome.value : [],
        emailType: email.kind,
      },
    ],
  };
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
  const dashboardUrl = workspaceUrl(
    party,
    recipient,
    document.rootDocumentId ?? document.id,
  );
  await stageNowAttemptAfter("document-upload notice", () =>
    stageBellAndEmail(
      () =>
        notifyDocumentUploaded(
          recipientUserId,
          {
            ...notificationScope(booking.organizationId),
            appointmentId: booking.id,
            documentId: document.id,
            uploadedByRole:
              party.role === "learner" ? "CONSULTEE" : "CONSULTANT",
            fileName: document.originalName,
            isThreaded: document.rootDocumentId !== null,
            versionNo: document.versionNo,
            consultantName: booking.expert.name,
            consulteeName: booking.learner.name,
            dashboardUrl,
          },
          { deferAttempt: true },
        ),
      {
        entityId: document.id,
        userIds: [recipientUserId],
        kind: "DOCUMENT_UPLOADED",
        actorName:
          party.role === "learner" ? booking.learner.name : booking.expert.name,
        fileName: document.originalName,
        versionNo: document.versionNo,
        dashboardUrl,
      },
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
  const dashboardUrl = workspaceUrl(
    party,
    "learner",
    document.rootDocumentId ?? document.id,
  );
  await stageNowAttemptAfter("document-review notice", () =>
    stageBellAndEmail(
      () =>
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
            dashboardUrl,
          },
          { deferAttempt: true },
        ),
      {
        entityId: document.id,
        userIds: [booking.learner.userId],
        kind: "DOCUMENT_REVIEWED",
        actorName: booking.expert.name,
        fileName: document.originalName,
        reviewStatus,
        reviewNotes,
        dashboardUrl,
      },
    ),
  );
}
