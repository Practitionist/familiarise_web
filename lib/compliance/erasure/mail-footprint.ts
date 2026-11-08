/**
 * The erased user's mailing footprint, scrubbed inside the erasure
 * transaction: newsletter rows are deleted, the address's pseudonymous newsletter
 * consent is withdrawn (kept as audit evidence like account consent), queued email
 * is dead-lettered and redacted, and every stored copy of the address is replaced
 * or removed. `EmailSuppression` is kept so the address stays unmailable.
 */

import { createHash } from "node:crypto";
import type { Tx } from "@/lib/prisma";
import { batchMessagesSchema } from "@/lib/email/batch-payload";
import { REDACTED_ERASED_BODY } from "@/lib/email/classify";
import { RECIPIENT_ERASED_REFUSAL } from "@/lib/email/delivery-policy";
import { ERASED_RECIPIENT_PREFIX } from "@/lib/email/erased-recipient";
import { normaliseEmail } from "@/lib/email/suppression";
import {
  lockNewsletterRows,
  withdrawNewsletterSubjects,
} from "@/lib/newsletter/consent-link";
import { UNSETTLED } from "@/lib/retry/provider-window";

/** The provider may already hold the batch's key, so its other recipients need an operator. */
export const ERASED_BATCH_REVIEW = "review:erased_recipient";

type MailTx = Pick<
  Tx,
  | "newsletterSubscriber"
  | "failedEmail"
  | "failedEmailBatch"
  | "consentArtifact"
>;

export interface MailFootprintScrub {
  newsletterDeleted: number;
  newsletterConsentWithdrawn: number;
  emailsDeadLettered: number;
  recipientsReplaced: number;
  entityRefsReplaced: number;
  replyTosCleared: number;
  batchesNarrowed: number;
  batchesDeadLettered: number;
  settledBatchesScrubbed: number;
}

/** A stable, non-identifying stand-in for an erased address. */
export function erasedRecipientMarker(email: string): string {
  const digest = createHash("sha256")
    .update(normaliseEmail(email))
    .digest("hex");
  return `${ERASED_RECIPIENT_PREFIX}${digest.slice(0, 16)}`;
}

export async function scrubMailFootprintTx(
  tx: MailTx,
  input: { userId: string; email: string },
): Promise<MailFootprintScrub> {
  const email = normaliseEmail(input.email);
  const sameAddress = { equals: email, mode: "insensitive" as const };
  const theirs = {
    OR: [{ deliveryUserId: input.userId }, { recipient: sameAddress }],
  };

  const newsletterRows = {
    OR: [{ userId: input.userId }, { email: sameAddress }],
  };
  const now = new Date();
  const subjects = await lockNewsletterRows(tx, newsletterRows, now);
  const newsletter = await tx.newsletterSubscriber.deleteMany({
    where: newsletterRows,
  });
  const consentWithdrawn = await withdrawNewsletterSubjects(tx, {
    email,
    subjectIds: subjects.map((row) => row.consentSubjectId),
    now,
  });
  const emails = await tx.failedEmail.updateMany({
    where: { status: UNSETTLED, ...theirs },
    data: {
      status: "DEAD_LETTER",
      lastError: RECIPIENT_ERASED_REFUSAL,
      subject: REDACTED_ERASED_BODY,
      htmlBody: REDACTED_ERASED_BODY,
      textBody: null,
    },
  });
  // Every row, settled ones included; the relay and the replay refuse the marker.
  const marker = erasedRecipientMarker(email);
  const recipients = await tx.failedEmail.updateMany({
    where: theirs,
    data: { recipient: marker },
  });
  // Newsletter and contact-form mail is anchored on the address itself, and its
  // body is about the person, so it is redacted too.
  const entityRefs = await tx.failedEmail.updateMany({
    where: {
      OR: ["newsletter", "contact"].map((kind) => ({
        entityRef: { equals: `${kind}:${email}`, mode: "insensitive" as const },
      })),
    },
    data: {
      entityRef: marker,
      subject: REDACTED_ERASED_BODY,
      htmlBody: REDACTED_ERASED_BODY,
      textBody: null,
    },
  });
  // A contact form replies to the visitor; null, not the marker, keeps a replay sendable.
  const replyTos = await tx.failedEmail.updateMany({
    where: { replyTo: { equals: email, mode: "insensitive" } },
    data: { replyTo: null },
  });
  const batches = await scrubBatches(tx, email);
  return {
    newsletterDeleted: newsletter.count,
    newsletterConsentWithdrawn: consentWithdrawn,
    emailsDeadLettered: emails.count,
    recipientsReplaced: recipients.count,
    entityRefsReplaced: entityRefs.count,
    replyTosCleared: replyTos.count,
    ...batches,
  };
}

/**
 * Drops the address from every batch that holds it. A queued batch the
 * provider has never seen keeps sending to the rest; a queued one it may have
 * seen is dead-lettered for review, because a narrowed payload cannot reuse
 * the stored key. A settled batch is never replayed, so it just loses them.
 */
async function scrubBatches(
  tx: MailTx,
  email: string,
): Promise<
  Pick<
    MailFootprintScrub,
    "batchesNarrowed" | "batchesDeadLettered" | "settledBatchesScrubbed"
  >
> {
  // Batch addresses come from `NewsletterSubscriber.email`, which is stored normalised.
  const rows = await tx.failedEmailBatch.findMany({
    where: { payload: { array_contains: [{ to: email }] } },
    select: { id: true, status: true, payload: true, firstAttemptAt: true },
  });
  const counts = {
    batchesNarrowed: 0,
    batchesDeadLettered: 0,
    settledBatchesScrubbed: 0,
  };
  for (const row of rows) {
    // An unparseable payload is dead-lettered by the relay without a send.
    const parsed = batchMessagesSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    const payload = parsed.data.filter((m) => normaliseEmail(m.to) !== email);
    if (payload.length === parsed.data.length) continue;

    if (row.status === "SENT" || row.status === "DEAD_LETTER") {
      const scrubbed = await tx.failedEmailBatch.updateMany({
        where: { id: row.id, status: row.status },
        data: { payload },
      });
      counts.settledBatchesScrubbed += scrubbed.count;
      continue;
    }
    if (!row.firstAttemptAt && payload.length > 0) {
      const narrowed = await tx.failedEmailBatch.updateMany({
        where: { id: row.id, status: UNSETTLED, firstAttemptAt: null },
        data: { payload },
      });
      if (narrowed.count > 0) {
        counts.batchesNarrowed += 1;
        continue;
      }
    }
    const dead = await tx.failedEmailBatch.updateMany({
      where: { id: row.id, status: UNSETTLED },
      data: {
        status: "DEAD_LETTER",
        lastError:
          payload.length === 0 ? RECIPIENT_ERASED_REFUSAL : ERASED_BATCH_REVIEW,
        payload,
      },
    });
    counts.batchesDeadLettered += dead.count;
  }
  return counts;
}
