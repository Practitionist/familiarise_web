/**
 * Erasure's mailing footprint against real Postgres: the user's newsletter
 * rows are gone, queued email is dead-lettered and redacted, queued batches
 * lose the address, and the suppression entry stays so the address is never
 * mailed again. Rows owned by anyone else are untouched.
 */
import { randomUUID } from "node:crypto";

import prisma from "../../lib/prisma";
import { REDACTED_ERASED_BODY } from "../../lib/email/classify";
import { scrubMailFootprintTx } from "../../lib/compliance/erasure/mail-footprint";
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
  status: "PENDING" | "RETRY" | "SENT";
  deliveryUserId?: string;
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

function queuedBatch(to: string[], firstAttemptAt: Date | null = null) {
  return prisma.failedEmailBatch.create({
    data: {
      idempotencyKey: `DB_TIER_TEST/${randomUUID()}`,
      emailType: "WAITLIST_BROADCAST",
      payload: to.map(message),
      firstAttemptAt,
    },
    select: { id: true },
  });
}

describe("erasure mailing footprint", () => {
  it("deletes newsletter rows, dead-letters and redacts queued mail, and keeps suppression", async () => {
    const { userId } = await seedUser();
    const email = `${userId}@db-tier.example.invalid`;
    const other = `${randomUUID()}@db-tier.example.invalid`;

    await prisma.waitlist.createMany({
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
    const sent = await queuedEmail({ recipient: email, status: "SENT" });
    const someoneElse = await queuedEmail({
      recipient: other,
      status: "PENDING",
    });
    const unseen = await queuedBatch([email, other]);
    const seen = await queuedBatch([other, email], new Date());
    const onlyUser = await queuedBatch([email]);

    const result = await prisma.$transaction((tx) =>
      scrubMailFootprintTx(tx, { userId, email }),
    );

    expect(result).toEqual({
      waitlistDeleted: 2,
      emailsDeadLettered: 2,
      batchesNarrowed: 1,
      batchesDeadLettered: 2,
    });
    expect(
      await prisma.waitlist.findMany({
        where: { OR: [{ userId }, { email }, { email: other }] },
        select: { email: true },
      }),
    ).toEqual([{ email: other }]);

    const emails = await prisma.failedEmail.findMany({
      where: {
        id: { in: [byUser.id, byAddress.id, sent.id, someoneElse.id] },
      },
      select: {
        id: true,
        status: true,
        lastError: true,
        subject: true,
        htmlBody: true,
        textBody: true,
      },
    });
    const row = (id: string) => emails.find((e) => e.id === id);
    for (const id of [byUser.id, byAddress.id]) {
      expect(row(id)).toMatchObject({
        status: "DEAD_LETTER",
        lastError: "policy:erased",
        subject: REDACTED_ERASED_BODY,
        htmlBody: REDACTED_ERASED_BODY,
        textBody: null,
      });
    }
    expect(row(sent.id)?.status).toBe("SENT");
    expect(row(someoneElse.id)).toMatchObject({
      status: "PENDING",
      htmlBody: `<p>${other}</p>`,
    });

    const batches = await prisma.failedEmailBatch.findMany({
      where: { id: { in: [unseen.id, seen.id, onlyUser.id] } },
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
      lastError: "policy:erased",
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
