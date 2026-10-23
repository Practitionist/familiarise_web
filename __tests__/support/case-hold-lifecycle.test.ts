/** @jest-environment node */
const mockHold = { id: "hold-1", caseId: "case-1", toValue: "pay-1" };
jest.mock("../../lib/support/case-holds", () => ({
  caseHoldEvents: jest.fn(async () => [mockHold]),
  activeHolds: jest.fn((events: unknown[]) => events),
  releaseAllCaseHolds: jest.fn(async () => [
    { holdId: "hold-1", paymentId: "pay-1" },
  ]),
}));
jest.mock("../../lib/backoffice/maintenance-gate", () => ({
  assertMoneyDoorsOpen: jest.fn(async () => undefined),
}));
jest.mock("../../lib/backoffice/ops-action-log", () => ({
  recordOpsAction: jest.fn(async () => ({ id: "ops-1" })),
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
const mockSync = jest.fn(async (_type: string, _id: string) => "unlocked");
jest.mock("../../lib/stream/support-boundary", () => ({
  syncSupportBoundary: (type: string, id: string) => mockSync(type, id),
}));
jest.mock("../../lib/support/case-access", () => ({
  canCorrespondOnCase: jest.fn(async () => true),
  caseCorrespondentIds: jest.fn(async () => []),
}));

import type { Tx } from "../../lib/prisma";
import { assertMoneyDoorsOpen } from "../../lib/backoffice/maintenance-gate";
import { OpsRefusal } from "../../lib/backoffice/ops-refusal-error";
import { recordOpsAction } from "../../lib/backoffice/ops-action-log";
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

function fakeTx(
  openRecommendation: { id: string } | null = null,
  liveGrants: Record<string, unknown>[] = [],
) {
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
    supportFinancialRecommendation: {
      findFirst: jest.fn(async () => openRecommendation),
    },
  } as unknown as Tx;
}
const fresh = { actorRole: "STAFF", freshSession: true };
const patch = (status: "RESOLVED" | "CLOSED" | "ESCALATED") => ({
  caseId: "case-1",
  actorId: "staff-1",
  expectedUpdatedAt: updatedAt.toISOString(),
  status,
});

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
      patch(status),
      new Date(),
      fresh,
    );
    expect(moved.ok).toBe(true);
    expect(releaseAllCaseHolds).toHaveBeenCalledWith(tx, {
      caseId: "case-1",
      actorId: "staff-1",
      note: `Released when the case was ${status.toLowerCase()}`,
    });
    expect(recordOpsAction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorUserId: "staff-1",
        targetId: "case-1",
        after: expect.objectContaining({
          holds: [{ holdId: "hold-1", paymentId: "pay-1" }],
        }),
      }),
    );
  },
);

it.each([
  ["no step-up grant", null, undefined, 403, "REAUTH_REQUIRED"],
  [
    "a stale session",
    null,
    { actorRole: "STAFF", freshSession: false },
    403,
    "REAUTH_REQUIRED",
  ],
  [
    "an open recommendation",
    { id: "rec-1" },
    fresh,
    409,
    "RECOMMENDATION_OPEN",
  ],
  ["maintenance on", null, fresh, 503, "MAINTENANCE"],
  ["maintenance unreadable", null, fresh, 503, "MAINTENANCE_UNKNOWN"],
] as const)(
  "refuses to release active holds with %s",
  async (_label, recommendation, grant, status, code) => {
    if (code.startsWith("MAINTENANCE"))
      jest
        .mocked(assertMoneyDoorsOpen)
        .mockRejectedValueOnce(new OpsRefusal(code, "paused", 503));
    const tx = fakeTx(recommendation);
    const moved = await executePatchLifecycleTx(
      tx,
      patch("RESOLVED"),
      new Date(),
      grant,
    );
    expect(moved).toMatchObject({ ok: false, status, code });
    expect(releaseAllCaseHolds).not.toHaveBeenCalled();
  },
);

it("keeps the holds while the case stays open", async () => {
  await executePatchLifecycleTx(fakeTx(), patch("ESCALATED"), new Date());
  expect(releaseAllCaseHolds).not.toHaveBeenCalled();
});

it("ends live chat grants in the same transaction and leaves and unlocks the chat after commit", async () => {
  const tx = fakeTx(null, [
    {
      id: "read-1",
      kind: "READ",
      channelType: "messaging",
      channelId: "dm-a-b",
      streamJoinedAt: null,
      streamLeftAt: null,
    },
    {
      id: "seat-1",
      kind: "INTERVENE",
      channelType: "messaging",
      channelId: "dm-a-b",
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
    fresh,
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
  expect(mockSync).not.toHaveBeenCalled();
  expect(mockScheduled).toHaveLength(1);
  await mockScheduled[0]();
  expect(mockLeave).toHaveBeenCalledWith("case-1");
  // One unlock per channel, after Support has left.
  expect(mockSync.mock.calls).toEqual([["messaging", "dm-a-b"]]);
  expect(mockLeave.mock.invocationCallOrder[0]).toBeLessThan(
    mockSync.mock.invocationCallOrder[0],
  );
});

it("only unlocks the channel when only read grants end", async () => {
  await executePatchLifecycleTx(
    fakeTx(null, [
      {
        id: "read-1",
        kind: "READ",
        channelType: "team",
        channelId: "webinar-web-1",
        streamJoinedAt: null,
        streamLeftAt: null,
      },
    ]),
    {
      caseId: "case-1",
      actorId: "staff-1",
      expectedUpdatedAt: updatedAt.toISOString(),
      status: "CLOSED",
    },
    new Date(),
    fresh,
  );
  expect(mockScheduled).toHaveLength(1);
  await mockScheduled[0]();
  expect(mockLeave).not.toHaveBeenCalled();
  expect(mockSync.mock.calls).toEqual([["team", "webinar-web-1"]]);
});

it("schedules nothing when no chat grant was live", async () => {
  const moved = await executePatchLifecycleTx(
    fakeTx(null, []),
    {
      caseId: "case-1",
      actorId: "staff-1",
      expectedUpdatedAt: updatedAt.toISOString(),
      status: "CLOSED",
    },
    new Date(),
    fresh,
  );
  expect(moved).toMatchObject({ ok: true });
  expect(mockScheduled).toHaveLength(0);
});
