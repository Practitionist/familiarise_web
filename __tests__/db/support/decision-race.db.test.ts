/** DECIDE races and clientActionId replays through performCaseAction on real Postgres. */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { isUniqueViolation } from "../../../lib/db/pg-errors";
import {
  CaseActionError,
  performCaseAction,
  type CaseActor,
} from "../../../lib/support/case-actions";
import {
  caseVersion,
  lockCaseRow,
  raceBehindLock,
  rowId,
  seedCase,
  seedUser,
  settledValues,
} from "../seed";

async function decidableCase() {
  const customer = await seedUser();
  const supportCase = await seedCase(customer.userId);
  return {
    caseId: supportCase.id,
    expectedUpdatedAt: await caseVersion(supportCase.id),
  };
}

function decide(
  caseId: string,
  actor: CaseActor,
  {
    clientActionId,
    expectedUpdatedAt,
    explanation,
  }: { clientActionId: string; expectedUpdatedAt: string; explanation: string },
) {
  return performCaseAction(caseId, actor, {
    action: "DECIDE",
    clientActionId,
    expectedUpdatedAt,
    outcome: "NO_REMEDY",
    explanation,
  });
}

describe("concurrent decisions", () => {
  it("records one decision; the other operator gets 409 CASE_ALREADY_DECIDED", async () => {
    const first = await seedUser("STAFF");
    const second = await seedUser("STAFF");
    const { caseId, expectedUpdatedAt } = await decidableCase();

    const { fulfilled, rejected } = settledValues(
      await raceBehindLock(lockCaseRow(caseId), [
        () =>
          decide(caseId, first, {
            clientActionId: randomUUID(),
            expectedUpdatedAt,
            explanation: "No remedy is due",
          }),
        () =>
          decide(caseId, second, {
            clientActionId: randomUUID(),
            expectedUpdatedAt,
            explanation: "The session ran in full",
          }),
      ]),
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(CaseActionError);
    expect(rejected[0]).toMatchObject({
      code: "CASE_ALREADY_DECIDED",
      status: 409,
      detail: { decisionId: rowId(fulfilled[0]) },
    });
    const decisions = await prisma.supportCaseDecision.findMany({
      where: { caseId },
    });
    expect(decisions.map((decision) => decision.id)).toEqual([
      rowId(fulfilled[0]),
    ]);
    const decided = await prisma.supportCase.findUniqueOrThrow({
      where: { id: caseId },
    });
    expect(decided.status).toBe("RESOLVED");
  });

  it("keeps one original decision per case and every decision immutable, below the app's checks", async () => {
    const staff = await seedUser("STAFF");
    const { caseId, expectedUpdatedAt } = await decidableCase();
    const decision = await decide(caseId, staff, {
      clientActionId: randomUUID(),
      expectedUpdatedAt,
      explanation: "No remedy is due",
    });

    const secondOriginal = await prisma.supportCaseDecision
      .create({
        data: {
          caseId,
          decidedById: staff.userId,
          clientActionId: randomUUID(),
          outcome: "SERVICE_REMEDY",
          explanation: "Written past the app",
          appealUntil: new Date(Date.now() + 86_400_000),
        },
      })
      .catch((error: unknown) => error);
    expect(isUniqueViolation(secondOriginal)).toBe(true);

    await expect(
      prisma.supportCaseDecision.update({
        where: { id: rowId(decision) },
        data: { explanation: "Rewritten" },
      }),
    ).rejects.toThrow(/immutable/i);
  });
});

describe("clientActionId replay", () => {
  it("replays the same DECIDE and refuses the key with other details", async () => {
    const staff = await seedUser("STAFF");
    const { caseId, expectedUpdatedAt } = await decidableCase();
    const clientActionId = randomUUID();
    const original = await decide(caseId, staff, {
      clientActionId,
      expectedUpdatedAt,
      explanation: "No remedy is due",
    });

    const replay = await decide(caseId, staff, {
      clientActionId,
      expectedUpdatedAt,
      explanation: "No remedy is due",
    });
    expect(rowId(replay)).toBe(rowId(original));

    await expect(
      decide(caseId, staff, {
        clientActionId,
        expectedUpdatedAt,
        explanation: "A different explanation",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
    await expect(
      performCaseAction(caseId, staff, {
        action: "REQUEST_EVIDENCE",
        clientActionId,
        expectedUpdatedAt,
        recipientUserId: staff.userId,
        prompt: "Please share the session record",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
    expect(await prisma.supportCaseDecision.count({ where: { caseId } })).toBe(
      1,
    );
  });

  it("refuses the losing double submit whose details differ", async () => {
    const staff = await seedUser("STAFF");
    const { caseId, expectedUpdatedAt } = await decidableCase();
    const clientActionId = randomUUID();

    const { fulfilled, rejected } = settledValues(
      await raceBehindLock(lockCaseRow(caseId), [
        () =>
          decide(caseId, staff, {
            clientActionId,
            expectedUpdatedAt,
            explanation: "No remedy is due",
          }),
        () =>
          decide(caseId, staff, {
            clientActionId,
            expectedUpdatedAt,
            explanation: "Edited before the retry",
          }),
      ]),
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      status: 409,
    });
    expect(await prisma.supportCaseDecision.count({ where: { caseId } })).toBe(
      1,
    );
  });
});
