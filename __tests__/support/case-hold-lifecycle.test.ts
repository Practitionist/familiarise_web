/** @jest-environment node */
jest.mock("../../lib/support/case-holds", () => ({
  releaseAllCaseHolds: jest.fn(async () => 1),
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: jest.fn(async () => null),
}));
jest.mock("../../lib/support/case-access", () => ({
  canCorrespondOnCase: jest.fn(async () => true),
  caseCorrespondentIds: jest.fn(async () => []),
}));

import type { Tx } from "../../lib/prisma";
import { releaseAllCaseHolds } from "../../lib/support/case-holds";
import { executePatchLifecycleTx } from "../../lib/support/case-service";

const updatedAt = new Date("2026-10-20T10:00:00Z");
const existing = {
  id: "case-1",
  status: "IN_PROGRESS",
  priority: "NORMAL",
  caseKind: "INCIDENT",
  assignedToId: null,
  problemCaseId: null,
  appealOfDecisionId: null,
  appealOfModerationActionId: null,
  awaitingUserSince: null,
  pausedSeconds: 0,
  resolvedAt: null,
  externalRequesterEmail: null,
  organizationId: null,
  ownershipScope: "PERSONAL",
  submitterUserId: "customer",
  requesterUserId: "customer",
  updatedAt,
};

function fakeTx() {
  return {
    supportCase: {
      findUnique: jest.fn(async () => existing),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: jest.fn(async () => ({ ...existing, events: [] })),
    },
    supportCaseEvent: { create: jest.fn(async () => ({})) },
  } as unknown as Tx;
}

beforeEach(() => jest.clearAllMocks());

it.each(["RESOLVED", "CLOSED"] as const)(
  "releases the case's payout holds when it is %s, including by a decision",
  async (status) => {
    const tx = fakeTx();
    const moved = await executePatchLifecycleTx(
      tx,
      {
        caseId: "case-1",
        actorId: "staff-1",
        expectedUpdatedAt: updatedAt.toISOString(),
        status,
      },
      new Date(),
    );
    expect(moved.ok).toBe(true);
    expect(releaseAllCaseHolds).toHaveBeenCalledWith(tx, {
      caseId: "case-1",
      actorId: "staff-1",
      note: `Released when the case was ${status.toLowerCase()}`,
    });
  },
);

it("keeps the holds while the case stays open", async () => {
  await executePatchLifecycleTx(
    fakeTx(),
    {
      caseId: "case-1",
      actorId: "staff-1",
      expectedUpdatedAt: updatedAt.toISOString(),
      status: "ESCALATED",
    },
    new Date(),
  );
  expect(releaseAllCaseHolds).not.toHaveBeenCalled();
});
