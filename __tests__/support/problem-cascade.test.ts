/** @jest-environment node */
const mockStageBell = jest.fn(
  async (_tx: unknown, args: { dedupeKey: string }) => ({
    transactionId: args.dedupeKey,
  }),
);
const mockStageEmail = jest.fn(async (..._args: unknown[]) => [
  { staged: { id: "email-row" }, message: { to: "c@example.test" } },
]);
const mockStageExternal = jest.fn(async (..._args: unknown[]) => ({
  staged: { id: "ext-row" },
  message: { to: "ext@example.test" },
}));
const mockReleaseHolds = jest.fn(async (..._args: unknown[]) => []);
const mockHoldEvents = jest.fn(async (..._args: unknown[]) => [] as unknown[]);
const mockOpenRecommendation = jest.fn(async (..._args: unknown[]) => null);
const mockCsat = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: (tx: unknown, args: { dedupeKey: string }) =>
    mockStageBell(tx, args),
}));
jest.mock("../../lib/email/senders/people", () => ({
  stageSupportTicketUpdateEmail: (...args: unknown[]) =>
    mockStageEmail(...args),
}));
jest.mock("../../lib/support/external-requester", () => ({
  stageExternalRequesterEmail: (...args: unknown[]) =>
    mockStageExternal(...args),
}));
jest.mock("../../lib/support/case-holds", () => ({
  caseHoldEvents: (...args: unknown[]) => mockHoldEvents(...args),
  activeHolds: (events: unknown[]) => events,
  releaseAllCaseHolds: (...args: unknown[]) => mockReleaseHolds(...args),
}));
jest.mock("../../lib/support/case-service", () => ({
  stageCaseResolutionCsatPromptTx: (...args: unknown[]) => mockCsat(...args),
  openRecommendationTx: (...args: unknown[]) => mockOpenRecommendation(...args),
  moneyDoorsRefusal: async () => null,
  recordLifecycleHoldReleaseTx: async () => undefined,
}));
jest.mock("../../lib/support/case-access", () => ({
  caseCorrespondentIds: jest.fn(async () => ["customer"]),
}));
jest.mock("../../lib/novu/resolve-href", () => ({
  supportRequestHref: (key: string) => `/dashboard/support/${key}`,
}));
jest.mock("../../lib/prisma", () => {
  const tx = {
    supportCase: { updateMany: jest.fn() },
    supportCaseEvent: { findFirst: jest.fn(), create: jest.fn() },
    supportCaseMessage: { create: jest.fn() },
    supportCaseChatAccess: {
      findMany: jest.fn(async () => [{ id: "g1", kind: "READ" }]),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const db = {
    supportCase: { findMany: jest.fn() },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    tx,
  };
  return {
    __esModule: true,
    default: db,
    ALLOCATION_TX_MAX_WAIT_MS: 1000,
    ALLOCATION_TX_TIMEOUT_MS: 1000,
  };
});

import prisma from "../../lib/prisma";
import { cascadeResolvedProblems } from "../../lib/support/problem-cascade";

const db = prisma as unknown as {
  supportCase: { findMany: jest.Mock };
  $transaction: jest.Mock;
  tx: {
    supportCase: { updateMany: jest.Mock };
    supportCaseEvent: { findFirst: jest.Mock; create: jest.Mock };
    supportCaseMessage: { create: jest.Mock };
    supportCaseChatAccess: { findMany: jest.Mock; updateMany: jest.Mock };
  };
};
const now = new Date("2026-10-22T00:00:00Z");
const problemResolvedAt = new Date("2026-10-21T00:00:00Z");
const incident = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  referenceNumber: `FAM-${id}`,
  title: "Video failed",
  submitterUserId: "customer",
  requesterUserId: "customer",
  organizationId: null,
  ownershipScope: "PERSONAL",
  externalRequesterEmail: null,
  status: "OPEN",
  updatedAt: now,
  messageSeq: 3,
  awaitingUserSince: null,
  pausedSeconds: 0,
  problemCaseId: "problem",
  problemCase: { referenceNumber: "FAM-P" },
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  db.tx.supportCase.updateMany.mockResolvedValue({ count: 1 });
  db.tx.supportCaseEvent.findFirst.mockResolvedValue({
    actorId: "staff",
    note: "We fixed the video outage.",
    createdAt: problemResolvedAt,
  });
});

it("queries only open incidents of a RESOLVED problem, oldest first, scanning twice the limit", async () => {
  db.supportCase.findMany.mockResolvedValue([]);
  await cascadeResolvedProblems({ limit: 7, now, errors: [] });
  expect(db.supportCase.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        caseKind: "INCIDENT",
        status: { notIn: ["RESOLVED", "CLOSED"] },
        deletedAt: null,
        problemCase: { status: "RESOLVED", deletedAt: null },
      },
      orderBy: { updatedAt: "asc" },
      take: 14,
    }),
  );
});

it("resolves each incident in its own transaction with the problem's notice, holds released and notices staged in-tx", async () => {
  db.supportCase.findMany.mockResolvedValue([incident("a"), incident("b")]);
  const errors: string[] = [];
  const result = await cascadeResolvedProblems({ limit: 10, now, errors });

  expect(result.cascaded).toBe(2);
  expect(errors).toEqual([]);
  expect(db.$transaction).toHaveBeenCalledTimes(2);
  expect(db.tx.supportCase.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        id: "a",
        status: "OPEN",
        updatedAt: now,
        messageSeq: 3,
        awaitingUserSince: null,
        pausedSeconds: 0,
        problemCaseId: "problem",
        problemCase: { status: "RESOLVED", deletedAt: null },
      },
      data: expect.objectContaining({
        status: "RESOLVED",
        resolvedAt: now,
        messageSeq: { increment: 1 },
      }),
    }),
  );
  expect(db.tx.supportCaseMessage.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      caseId: "a",
      seq: 4,
      sender: "AGENT",
      body: "We fixed the video outage.",
      isInternal: false,
      authorUserId: "staff",
    }),
  });
  expect(db.tx.supportCaseEvent.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      caseId: "a",
      kind: "STATUS_CHANGED",
      toValue: "RESOLVED",
      note: "Resolved via problem FAM-P",
    }),
  });
  expect(mockReleaseHolds).toHaveBeenCalledWith(db.tx, {
    caseId: "a",
    actorId: "staff",
    note: "Released when the case was resolved",
  });
  // Chat access on a cascaded incident ends in the same transaction.
  expect(db.tx.supportCaseChatAccess.updateMany).toHaveBeenCalledWith({
    where: { id: "g1", endedAt: null },
    data: { endedAt: now, endedById: "staff", endReason: "CASE_RESOLVED" },
  });
  expect(mockStageBell).toHaveBeenCalledWith(
    db.tx,
    expect.objectContaining({
      recipients: ["customer"],
      dedupeKey: `case-status:a:RESOLVED:${now.getTime()}`,
    }),
  );
  expect(mockStageEmail).toHaveBeenCalledWith(
    db.tx,
    expect.objectContaining({ ticketId: "a", statusCode: "RESOLVED" }),
  );
  expect(mockCsat).toHaveBeenCalledWith(db.tx, expect.anything(), now);
  expect(result.bells).toHaveLength(2);
  expect(result.emails).toHaveLength(2);
});

it("skips an incident whose problem was reopened (CAS misses) without staging anything", async () => {
  db.supportCase.findMany.mockResolvedValue([incident("a")]);
  db.tx.supportCase.updateMany.mockResolvedValue({ count: 0 });
  const result = await cascadeResolvedProblems({ limit: 10, now, errors: [] });
  expect(result.cascaded).toBe(0);
  expect(db.tx.supportCaseEvent.create).not.toHaveBeenCalled();
  expect(mockStageBell).not.toHaveBeenCalled();
  expect(mockReleaseHolds).not.toHaveBeenCalled();
});

it("leaves open and reports an incident whose holds sit under an open recommendation", async () => {
  db.supportCase.findMany.mockResolvedValue([incident("a"), incident("b")]);
  mockHoldEvents.mockResolvedValueOnce([{ id: "hold-1", caseId: "a" }]);
  mockOpenRecommendation.mockResolvedValueOnce({ id: "rec-1" } as never);
  const errors: string[] = [];
  const result = await cascadeResolvedProblems({ limit: 10, now, errors });
  expect(result).toMatchObject({
    cascaded: 1,
    heldOpen: [{ caseId: "a", code: "RECOMMENDATION_OPEN" }],
  });
  expect(db.tx.supportCase.updateMany).toHaveBeenCalledTimes(1);
  expect(errors).toEqual([]);
});

it("leaves open an incident whose hold was placed after the problem resolved, releasing only earlier holds", async () => {
  db.supportCase.findMany.mockResolvedValue([incident("a"), incident("b")]);
  const at = (ms: number) => new Date(problemResolvedAt.getTime() + ms);
  mockHoldEvents
    .mockResolvedValueOnce([{ id: "late", caseId: "a", createdAt: at(1) }])
    .mockResolvedValueOnce([{ id: "early", caseId: "b", createdAt: at(-1) }]);
  const result = await cascadeResolvedProblems({ limit: 10, now, errors: [] });
  expect(result).toMatchObject({
    cascaded: 1,
    heldOpen: [{ caseId: "a", code: "HOLD_AFTER_PROBLEM_RESOLVED" }],
  });
  expect(mockReleaseHolds).toHaveBeenCalledTimes(1);
  expect(mockReleaseHolds).toHaveBeenCalledWith(
    db.tx,
    expect.objectContaining({ caseId: "b" }),
  );
});

it("scans past held-open incidents but cascades no more than the limit", async () => {
  db.supportCase.findMany.mockResolvedValue([
    incident("a"),
    incident("b"),
    incident("c"),
  ]);
  mockHoldEvents.mockResolvedValueOnce([{ id: "hold-1", caseId: "a" }]);
  mockOpenRecommendation.mockResolvedValueOnce({ id: "rec-1" } as never);
  const result = await cascadeResolvedProblems({ limit: 1, now, errors: [] });
  expect(result).toMatchObject({
    cascaded: 1,
    heldOpen: [{ caseId: "a", code: "RECOMMENDATION_OPEN" }],
  });
  expect(db.$transaction).toHaveBeenCalledTimes(2);
});

it("writes no closing message when the problem's RESOLVED event has no note", async () => {
  db.supportCase.findMany.mockResolvedValue([incident("a")]);
  db.tx.supportCaseEvent.findFirst.mockResolvedValue({
    actorId: "staff",
    note: null,
  });
  await cascadeResolvedProblems({ limit: 10, now, errors: [] });
  expect(db.tx.supportCaseMessage.create).not.toHaveBeenCalled();
  expect(db.tx.supportCase.updateMany.mock.calls[0][0].data).not.toHaveProperty(
    "messageSeq",
  );
});

it("emails an external requester instead of staging a bell", async () => {
  db.supportCase.findMany.mockResolvedValue([
    incident("a", { externalRequesterEmail: "ext@example.test" }),
  ]);
  const result = await cascadeResolvedProblems({ limit: 10, now, errors: [] });
  expect(mockStageExternal).toHaveBeenCalledWith(
    expect.objectContaining({ caseId: "a", to: "ext@example.test" }),
    db.tx,
  );
  expect(mockStageBell).not.toHaveBeenCalled();
  expect(result.emails).toHaveLength(1);
});

it("collects a failing incident into errors and still processes the next", async () => {
  db.supportCase.findMany.mockResolvedValue([incident("a"), incident("b")]);
  db.tx.supportCase.updateMany
    .mockRejectedValueOnce(new Error("deadlock"))
    .mockResolvedValueOnce({ count: 1 });
  const errors: string[] = [];
  const result = await cascadeResolvedProblems({ limit: 10, now, errors });
  expect(result.cascaded).toBe(1);
  expect(errors).toEqual(["problem-cascade incident a: deadlock"]);
  expect(result.bells).toHaveLength(1);
});
