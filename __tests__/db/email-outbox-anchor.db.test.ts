/**
 * Email outbox SQL semantics the unit stores only imitate:
 *  - the first-attempt anchor is a compare-and-set, so concurrent attempts
 *    keep the earliest stamp and a later attempt never moves it;
 *  - the dead-letter predicate keeps NULL reasons while dropping holds and
 *    policy/suppression refusals (`NOT LIKE` alone would drop the NULLs).
 */
import { randomUUID } from "node:crypto";

import prisma from "../../lib/prisma";
import { DEAD_LETTER_EMAIL_WHERE } from "../../lib/backoffice/queue-predicates";
import { HELD_PRE_LAUNCH } from "../../lib/email/held";
import { stampFirstAttempt } from "../../lib/retry/provider-window";

function emailRow(entityRef: string, lastError: string | null = null) {
  return prisma.failedEmail.create({
    data: {
      recipient: `${randomUUID()}@example.test`,
      subject: "First attempt",
      htmlBody: "<p>hi</p>",
      emailType: "DB_TIER_TEST",
      status: lastError === null ? "PENDING" : "DEAD_LETTER",
      lastError,
      entityRef,
    },
    select: { id: true },
  });
}

describe("first-attempt anchor", () => {
  it("lets exactly one concurrent stamp win and never moves it afterwards", async () => {
    const { id } = await emailRow(`db-tier:${randomUUID()}`);
    const early = new Date("2026-11-06T10:00:00Z");
    const late = new Date("2026-11-06T10:00:05Z");

    const counts = await Promise.all(
      [early, late].map((at) =>
        prisma.failedEmail.updateMany({
          where: { id, firstAttemptAt: null },
          data: { firstAttemptAt: at },
        }),
      ),
    );
    expect(counts.map((c) => c.count).sort()).toEqual([0, 1]);
    const won = (
      await prisma.failedEmail.findUniqueOrThrow({
        where: { id },
        select: { firstAttemptAt: true },
      })
    ).firstAttemptAt;
    expect([early.getTime(), late.getTime()]).toContain(won?.getTime());

    await stampFirstAttempt(
      prisma.failedEmail,
      id,
      new Date("2026-11-07T10:00:00Z"),
    );
    const after = await prisma.failedEmail.findUniqueOrThrow({
      where: { id },
      select: { firstAttemptAt: true },
    });
    expect(after.firstAttemptAt?.getTime()).toBe(won?.getTime());
  });

  it("stamps a batch row once", async () => {
    const batch = await prisma.failedEmailBatch.create({
      data: {
        idempotencyKey: `DB_TIER_TEST/${randomUUID()}`,
        emailType: "DB_TIER_TEST",
        payload: [],
      },
      select: { id: true },
    });
    const first = new Date("2026-11-06T10:00:00Z");
    await stampFirstAttempt(prisma.failedEmailBatch, batch.id, first);
    await stampFirstAttempt(
      prisma.failedEmailBatch,
      batch.id,
      new Date("2026-11-06T12:00:00Z"),
    );
    const row = await prisma.failedEmailBatch.findUniqueOrThrow({
      where: { id: batch.id },
      select: { firstAttemptAt: true },
    });
    expect(row.firstAttemptAt?.getTime()).toBe(first.getTime());
  });
});

describe("DEAD_LETTER_EMAIL_WHERE", () => {
  it("counts real failures and NULL reasons, not holds or recipient refusals", async () => {
    const entityRef = `db-tier:${randomUUID()}`;
    const actionable = [
      await emailRow(entityRef, "Resend 503"),
      await emailRow(entityRef, "review:provider_acceptance_unknown"),
    ];
    const nullReason = await prisma.failedEmail.create({
      data: {
        recipient: `${randomUUID()}@example.test`,
        subject: "No reason",
        htmlBody: "<p>hi</p>",
        emailType: "DB_TIER_TEST",
        status: "DEAD_LETTER",
        entityRef,
      },
      select: { id: true },
    });
    await emailRow(entityRef, HELD_PRE_LAUNCH);
    await emailRow(entityRef, "policy:preference_changed");
    await emailRow(entityRef, "suppressed:COMPLAINT");

    const rows = await prisma.failedEmail.findMany({
      where: { AND: [DEAD_LETTER_EMAIL_WHERE, { entityRef }] },
      select: { id: true },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(
      [...actionable, nullReason].map((r) => r.id).sort(),
    );
  });
});
