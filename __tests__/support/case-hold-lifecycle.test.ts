/** @jest-environment node */
jest.mock("../../lib/support/case-holds", () => ({
  releaseAllCaseHolds: jest.fn(async () => 1),
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: jest.fn(async () => null),
}));
const mockScheduled: (() => unknown)[] = [];
jest.mock("../../lib/api/after-safe", () => ({
  scheduleAfter: (task: () => unknown) => {
    mockScheduled.push(task);
    return Promise.resolve();
  },
}));
const mockLeave = jest.fn(async (_caseId: string) => undefined);
jest.mock("../../lib/stream/support-intervention", () => ({
  leavePendingInterventions: (caseId: string) => mockLeave(caseId),
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

function fakeTx(liveGrants: Record<string, unknown>[] = []) {
  return {
    supportCaseChatAccess: {
      findMany: jest.fn(async () => liveGrants),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    supportCase: {
      findUnique: jest.fn(async () => existing),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: jest.fn(async () => ({ ...existing, events: [] })),
    },
    supportCaseEvent: { create: jest.fn(async () => ({})) },
  } as unknown as Tx;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockScheduled.length = 0;
});

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

it("ends live chat grants in the same transaction and leaves the chat after commit", async () => {
  const tx = fakeTx([
    {
      id: "read-1",
      kind: "READ",
      streamJoinedAt: null,
      streamLeftAt: null,
    },
    {
      id: "seat-1",
      kind: "INTERVENE",
      streamJoinedAt: new Date(),
      streamLeftAt: null,
    },
  ]);
  const now = new Date();
  await executePatchLifecycleTx(
    tx,
    {
      caseId: "case-1",
      actorId: "staff-1",
      expectedUpdatedAt: updatedAt.toISOString(),
      status: "RESOLVED",
    },
    now,
  );
  const db = tx as unknown as {
    supportCaseChatAccess: { updateMany: jest.Mock };
    supportCaseEvent: { create: jest.Mock };
  };
  expect(db.supportCaseChatAccess.updateMany.mock.calls).toEqual([
    [
      {
        where: { id: "read-1", endedAt: null },
        data: {
          endedAt: now,
          endedById: "staff-1",
          endReason: "CASE_RESOLVED",
        },
      },
    ],
    [
      {
        where: { id: "seat-1", endedAt: null },
        data: {
          endedAt: now,
          endedById: "staff-1",
          endReason: "CASE_RESOLVED",
        },
      },
    ],
  ]);
  expect(db.supportCaseEvent.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      kind: "CHAT_ACCESS_ENDED",
      toValue: "seat-1",
      note: "CASE_RESOLVED",
    }),
  });
  expect(mockLeave).not.toHaveBeenCalled();
  expect(mockScheduled).toHaveLength(1);
  await mockScheduled[0]();
  expect(mockLeave).toHaveBeenCalledWith("case-1");
});

it("schedules no Stream leave when only read grants end", async () => {
  await executePatchLifecycleTx(
    fakeTx([
      { id: "read-1", kind: "READ", streamJoinedAt: null, streamLeftAt: null },
    ]),
    {
      caseId: "case-1",
      actorId: "staff-1",
      expectedUpdatedAt: updatedAt.toISOString(),
      status: "CLOSED",
    },
    new Date(),
  );
  expect(mockScheduled).toHaveLength(0);
});
