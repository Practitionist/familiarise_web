/** Intake and reopen against the real open-scope unique index (sidecar `support_case_open_scope_key`). */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  createOrReuseSupportCase,
  patchSupportCaseLifecycle,
} from "../../../lib/support/case-service";
import { runSupportTurn } from "../../../lib/support/service";
import {
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "../booking/harness";
import {
  caseVersion,
  intakeFor,
  lockReferenceCounter,
  raceBehindLock,
  seedCase,
  seedUser,
  settledValues,
} from "../seed";

describe("intake races on one open scope", () => {
  it("creates one case and appends the losing intake to it", async () => {
    const customer = await seedUser();
    const intake = intakeFor(customer.userId);

    // Both pass the open-scope read, then queue on the reference counter.
    const { fulfilled, rejected } = settledValues(
      await raceBehindLock(await lockReferenceCounter(), [
        () =>
          createOrReuseSupportCase({
            ...intake,
            description: "From the first tab",
          }),
        () =>
          createOrReuseSupportCase({
            ...intake,
            description: "From the second tab",
          }),
      ]),
    );

    expect(rejected).toEqual([]);
    const created = fulfilled.filter((result) => !result.reused);
    const reused = fulfilled.filter((result) => result.reused);
    expect(created).toHaveLength(1);
    expect(reused).toHaveLength(1);
    expect(reused[0].dedupeReason).toBe("open_scope");
    expect(reused[0].supportCase.id).toBe(created[0].supportCase.id);

    const cases = await prisma.supportCase.findMany({
      where: { requesterUserId: customer.userId },
      include: { messages: { orderBy: { seq: "asc" } } },
    });
    expect(cases).toHaveLength(1);
    expect(cases[0].messageSeq).toBe(2);
    expect(cases[0].messages.map((message) => message.body).sort()).toEqual([
      "From the first tab",
      "From the second tab",
    ]);
  });

  it("answers a double-submitted intake with the one case it created", async () => {
    const customer = await seedUser();
    const intake = intakeFor(customer.userId, { clientIntakeId: randomUUID() });

    const { fulfilled, rejected } = settledValues(
      await raceBehindLock(await lockReferenceCounter(), [
        () => createOrReuseSupportCase(intake),
        () => createOrReuseSupportCase(intake),
      ]),
    );

    expect(rejected).toEqual([]);
    expect(fulfilled.map((result) => result.reused).sort()).toEqual([
      false,
      true,
    ]);
    expect(fulfilled.find((result) => result.reused)?.dedupeReason).toBe(
      "client_intake_id",
    );
    const cases = await prisma.supportCase.findMany({
      where: { requesterUserId: customer.userId },
      include: { messages: true },
    });
    expect(cases).toHaveLength(1);
    expect(cases[0].messages).toHaveLength(1);
  });
});

describe("a no-show report on a past session", () => {
  it("opens the session's own case beside an open booking thread and keeps the terminal's reason", async () => {
    const host = await seedHost();
    const learner = await seedConsultee();
    const endsAt = new Date(Date.now() - 2 * HOUR_MS);
    const booking = await seedOneToOne(
      "consultation",
      host,
      learner,
      { startsAt: new Date(endsAt.getTime() - HOUR_MS), endsAt },
      {
        status: "COMPLETED",
        isTentative: false,
        completionStatus: "COMPLETED",
      },
    );
    const thread = await seedCase(learner.userId, {
      category: "PAYMENT_STATUS",
      appointmentId: booking.appointmentId,
    });

    const first = await runSupportTurn(booking.appointmentId, learner.userId, {
      category: "NO_SHOW",
    });
    // The client names the session the first turn answered on.
    const result = await runSupportTurn(booking.appointmentId, learner.userId, {
      chosenOptionId: "expert",
      appointmentOccurrenceId: first?.appointmentOccurrenceId ?? undefined,
    });

    const report = await prisma.supportCase.findFirstOrThrow({
      where: { requesterUserId: learner.userId, category: "NO_SHOW" },
    });
    expect(result?.threadId).toBe(report.id);
    expect(report).toMatchObject({
      appointmentOccurrenceId: booking.occurrenceId,
      scopeKey: `OCCURRENCE:${booking.occurrenceId}`,
      flowReason: "provider_no_show",
      flowReasonAt: expect.any(Date),
      activeChannel: "HUMAN",
    });
    const other = await prisma.supportCase.findUniqueOrThrow({
      where: { id: thread.id },
    });
    expect(other).toMatchObject({
      category: "PAYMENT_STATUS",
      flowReason: null,
    });
  });
});

describe("staff reopen of a closed case", () => {
  it("returns 409 OPEN_CASE_EXISTS naming the newer open case that holds the scope", async () => {
    const customer = await seedUser();
    const staff = await seedUser("STAFF");
    const closedCase = await seedCase(customer.userId);
    const closed = await patchSupportCaseLifecycle({
      caseId: closedCase.id,
      actorId: staff.userId,
      expectedUpdatedAt: await caseVersion(closedCase.id),
      status: "CLOSED",
    });
    expect(closed.ok).toBe(true);
    const newerCase = await seedCase(customer.userId);
    expect(newerCase.id).not.toBe(closedCase.id);

    const reopened = await patchSupportCaseLifecycle({
      caseId: closedCase.id,
      actorId: staff.userId,
      expectedUpdatedAt: await caseVersion(closedCase.id),
      status: "OPEN",
    });

    expect(reopened).toMatchObject({
      ok: false,
      status: 409,
      code: "OPEN_CASE_EXISTS",
      existingCase: {
        id: newerCase.id,
        referenceNumber: newerCase.referenceNumber,
      },
    });
    const after = await prisma.supportCase.findUniqueOrThrow({
      where: { id: closedCase.id },
    });
    expect(after.status).toBe("CLOSED");
    expect(after.closedAt).not.toBeNull();
  });
});
