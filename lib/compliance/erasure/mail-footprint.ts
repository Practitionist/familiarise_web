/**
 * The erased user's mailing footprint, scrubbed inside the erasure
 * transaction: newsletter rows are deleted and queued email is dead-lettered
 * and redacted. `EmailSuppression` is kept so the address stays unmailable.
 */

import type { Tx } from "@/lib/prisma";
import { batchMessagesSchema } from "@/lib/email/batch-payload";
import { REDACTED_ERASED_BODY } from "@/lib/email/classify";
import { normaliseEmail } from "@/lib/email/suppression";
import { UNSETTLED } from "@/lib/retry/provider-window";

/** An expected refusal: never paged, never replayed. */
export const ERASED_POLICY_REASON = "policy:erased";
/** The provider may already hold the batch's key, so its other recipients need an operator. */
export const ERASED_BATCH_REVIEW = "review:erased_recipient";

type MailTx = Pick<Tx, "waitlist" | "failedEmail" | "failedEmailBatch">;

export interface MailFootprintScrub {
  waitlistDeleted: number;
  emailsDeadLettered: number;
  batchesNarrowed: number;
  batchesDeadLettered: number;
}

export async function scrubMailFootprintTx(
  tx: MailTx,
  input: { userId: string; email: string },
): Promise<MailFootprintScrub> {
  const email = normaliseEmail(input.email);
  const sameAddress = { equals: email, mode: "insensitive" as const };

  const waitlist = await tx.waitlist.deleteMany({
    where: { OR: [{ userId: input.userId }, { email: sameAddress }] },
  });
  const emails = await tx.failedEmail.updateMany({
    where: {
      status: UNSETTLED,
      OR: [{ deliveryUserId: input.userId }, { recipient: sameAddress }],
    },
    data: {
      status: "DEAD_LETTER",
      lastError: ERASED_POLICY_REASON,
      subject: REDACTED_ERASED_BODY,
      htmlBody: REDACTED_ERASED_BODY,
      textBody: null,
    },
  });
  const batches = await scrubQueuedBatches(tx, email);
  return {
    waitlistDeleted: waitlist.count,
    emailsDeadLettered: emails.count,
    ...batches,
  };
}

/**
 * Drops the address from every queued batch. A batch the provider has never
 * seen keeps sending to the rest; one it may have seen is dead-lettered for
 * review, because a narrowed payload cannot reuse the stored key.
 */
async function scrubQueuedBatches(
  tx: MailTx,
  email: string,
): Promise<
  Pick<MailFootprintScrub, "batchesNarrowed" | "batchesDeadLettered">
> {
  const rows = await tx.failedEmailBatch.findMany({
    where: { status: UNSETTLED },
    select: { id: true, payload: true, firstAttemptAt: true },
  });
  let batchesNarrowed = 0;
  let batchesDeadLettered = 0;
  for (const row of rows) {
    // An unparseable payload is dead-lettered by the relay without a send.
    const parsed = batchMessagesSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    const payload = parsed.data.filter((m) => normaliseEmail(m.to) !== email);
    if (payload.length === parsed.data.length) continue;

    if (!row.firstAttemptAt && payload.length > 0) {
      const narrowed = await tx.failedEmailBatch.updateMany({
        where: { id: row.id, status: UNSETTLED, firstAttemptAt: null },
        data: { payload },
      });
      if (narrowed.count > 0) {
        batchesNarrowed += 1;
        continue;
      }
    }
    const dead = await tx.failedEmailBatch.updateMany({
      where: { id: row.id, status: UNSETTLED },
      data: {
        status: "DEAD_LETTER",
        lastError:
          payload.length === 0 ? ERASED_POLICY_REASON : ERASED_BATCH_REVIEW,
        payload,
      },
    });
    batchesDeadLettered += dead.count;
  }
  return { batchesNarrowed, batchesDeadLettered };
}
