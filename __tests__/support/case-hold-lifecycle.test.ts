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
jest.mock("../../lib/support/case-access", () => ({
  canCorrespondOnCase: jest.fn(async () => true),
  caseCorrespondentIds: jest.fn(async () => []),
}));

import type { Tx } from "../../lib/prisma";
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

function fakeTx(openRecommendation: { id: string } | null = null) {
  return {
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

beforeEach(() => jest.clearAllMocks());

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
  ["a stale session", null, undefined, 403, "REAUTH_REQUIRED"],
  [
    "an open recommendation",
    { id: "rec-1" },
    fresh,
    409,
    "RECOMMENDATION_OPEN",
  ],
] as const)(
  "refuses to release active holds with %s",
  async (_label, recommendation, grant, status, code) => {
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
