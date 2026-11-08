/**
 * Erasure's mailing footprint against real Postgres: the user's newsletter
 * rows are gone, queued email is dead-lettered and redacted, queued batches
 * lose the address, and the suppression entry stays so the address is never
 * mailed again. Rows owned by anyone else are untouched.
 */
import { randomUUID } from "node:crypto";

import prisma from "../../lib/prisma";
import { REDACTED_ERASED_BODY } from "../../lib/email/classify";
import {
  erasedRecipientMarker,
  scrubMailFootprintTx,
} from "../../lib/compliance/erasure/mail-footprint";
import { seedUser } from "./seed";

function message(to: string) {
  return {
    from: "Familiarise <news@mail.familiarise.test>",
    to,
    subject: "Newsletter",
    html: `<p>Hello ${to}</p>`,
  };
}

function queuedEmail(data: {
  recipient: string;
  status: "PENDING" | "RETRY" | "SENT" | "DEAD_LETTER";
  deliveryUserId?: string;
  lastError?: string;
  entityRef?: string;
  replyTo?: string;
}) {
  return prisma.failedEmail.create({
    data: {
      subject: `For ${data.recipient}`,
      htmlBody: `<p>${data.recipient}</p>`,
      textBody: data.recipient,
      emailType: "DB_TIER_TEST",
      ...data,
    },
    select: { id: true },
  });
}

function queuedBatch(
  to: string[],
  firstAttemptAt: Date | null = null,
  status: "PENDING" | "SENT" | "DEAD_LETTER" = "PENDING",
) {
  return prisma.failedEmailBatch.create({
    data: {
      idempotencyKey: `DB_TIER_TEST/${randomUUID()}`,
      emailType: "NEWSLETTER_BROADCAST",
      payload: to.map(message),
      firstAttemptAt,
      status,
    },
    select: { id: true },
  });
}

describe("erasure mailing footprint", () => {
  it("deletes newsletter rows, scrubs queued and settled mail, and keeps suppression", async () => {
    const { userId } = await seedUser();
    const email = `${userId}@db-tier.example.invalid`;
    const other = `${randomUUID()}@db-tier.example.invalid`;

    await prisma.newsletterSubscriber.createMany({
      data: [
        { email: `linked-${userId}@db-tier.example.invalid`, userId },
        { email, status: "SUBSCRIBED" },
        { email: other, status: "SUBSCRIBED" },
      ],
    });
    await prisma.emailSuppression.create({
      data: { email, reason: "COMPLAINT" },
    });
    const byUser = await queuedEmail({
      recipient: `old-${userId}@db-tier.example.invalid`,
      status: "PENDING",
      deliveryUserId: userId,
    });
    const byAddress = await queuedEmail({
      recipient: email.toUpperCase(),
      status: "RETRY",
    });
    const sent = await queuedEmail({
      recipient: email,
      status: "SENT",
      entityRef: `newsletter:${email}`,
    });
    const dead = await queuedEmail({
      recipient: email,
      status: "DEAD_LETTER",
      lastError: "review:provider_acceptance_unknown",
    });
    const contact = await queuedEmail({
      recipient: "support@familiarise.test",
      status: "SENT",
      entityRef: `contact:${email.toUpperCase()}`,
      replyTo: email,
    });
    const someoneElse = await queuedEmail({
      recipient: other,
      status: "PENDING",
    });
    const unseen = await queuedBatch([email, other]);
    const seen = await queuedBatch([other, email], new Date());
    const onlyUser = await queuedBatch([email]);
    const sentBatch = await queuedBatch([email, other], new Date(), "SENT");
    const deadBatch = await queuedBatch([email], new Date(), "DEAD_LETTER");

    const result = await prisma.$transaction((tx) =>
      scrubMailFootprintTx(tx, { userId, email }),
    );

    expect(result).toEqual({
      newsletterDeleted: 2,
      newsletterConsentWithdrawn: 0,
      emailsDeadLettered: 2,
      recipientsReplaced: 4,
      entityRefsReplaced: 2,
      replyTosCleared: 1,
      batchesNarrowed: 1,
      batchesDeadLettered: 2,
      settledBatchesScrubbed: 2,
    });
    expect(
      await prisma.newsletterSubscriber.findMany({
        where: { OR: [{ userId }, { email }, { email: other }] },
        select: { email: true },
      }),
    ).toEqual([{ email: other }]);

    const emails = await prisma.failedEmail.findMany({
      where: {
        id: {
          in: [
            byUser.id,
            byAddress.id,
            sent.id,
            dead.id,
            contact.id,
            someoneElse.id,
          ],
        },
      },
      select: {
        id: true,
        recipient: true,
        entityRef: true,
        status: true,
        lastError: true,
        subject: true,
        htmlBody: true,
        textBody: true,
        replyTo: true,
      },
    });
    const row = (id: string) => emails.find((e) => e.id === id);
    const marker = erasedRecipientMarker(email);
    expect(marker).toMatch(/^erased:[0-9a-f]{16}$/);
    for (const id of [byUser.id, byAddress.id]) {
      expect(row(id)).toMatchObject({
        recipient: marker,
        status: "DEAD_LETTER",
        lastError: "policy:recipient_erased",
        subject: REDACTED_ERASED_BODY,
        htmlBody: REDACTED_ERASED_BODY,
        textBody: null,
      });
    }
    expect(row(sent.id)).toMatchObject({
      recipient: marker,
      entityRef: marker,
      status: "SENT",
    });
    expect(row(dead.id)).toMatchObject({
      recipient: marker,
      status: "DEAD_LETTER",
      lastError: "review:provider_acceptance_unknown",
    });
    expect(row(contact.id)).toMatchObject({
      recipient: "support@familiarise.test",
      entityRef: marker,
      replyTo: null,
      status: "SENT",
      subject: REDACTED_ERASED_BODY,
      htmlBody: REDACTED_ERASED_BODY,
      textBody: null,
    });
    expect(row(someoneElse.id)).toMatchObject({
      recipient: other,
      status: "PENDING",
      htmlBody: `<p>${other}</p>`,
    });

    const batches = await prisma.failedEmailBatch.findMany({
      where: {
        id: {
          in: [unseen.id, seen.id, onlyUser.id, sentBatch.id, deadBatch.id],
        },
      },
      select: { id: true, status: true, lastError: true, payload: true },
    });
    const batch = (id: string) => batches.find((b) => b.id === id);
    expect(batch(unseen.id)).toMatchObject({
      status: "PENDING",
      lastError: null,
      payload: [message(other)],
    });
    expect(batch(seen.id)).toMatchObject({
      status: "DEAD_LETTER",
      lastError: "review:erased_recipient",
      payload: [message(other)],
    });
    expect(batch(onlyUser.id)).toMatchObject({
      status: "DEAD_LETTER",
      lastError: "policy:recipient_erased",
      payload: [],
    });
    expect(batch(sentBatch.id)).toMatchObject({
      status: "SENT",
      payload: [message(other)],
    });
    expect(batch(deadBatch.id)).toMatchObject({
      status: "DEAD_LETTER",
      payload: [],
    });

    expect(
      await prisma.emailSuppression.findUnique({
        where: { email },
        select: { reason: true },
      }),
    ).toEqual({ reason: "COMPLAINT" });
  });
});
