/** @jest-environment node */
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: jest.fn(async () => null),
}));
jest.mock("../../lib/email/deliver", () => ({
  stage: jest.fn(async () => null),
}));
jest.mock("../../lib/novu/resolve-href", () => ({
  supportRequestHref: (key: string) => `/dashboard/support/${key}`,
}));
jest.mock("../../lib/support/case-holds", () => ({
  caseHoldEvents: jest.fn(async () => []),
  activeHolds: jest.fn(() => []),
  releaseAllCaseHolds: jest.fn(async () => []),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    supportCase: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    supportCaseMessage: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    supportCaseEvent: { create: jest.fn() },
    supportCaseChatAccess: {
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    supportCaseDecision: { findFirst: jest.fn() },
    user: {
      findMany: jest.fn(async () => [{ id: "staff" }]),
      findUnique: jest.fn(),
    },
    membership: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((callback: (tx: typeof db) => unknown) =>
    callback(db),
  );
  return {
    __esModule: true,
    default: db,
    ALLOCATION_TX_MAX_WAIT_MS: 1000,
    ALLOCATION_TX_TIMEOUT_MS: 1000,
  };
});

import prisma from "../../lib/prisma";
import {
  appendSupportCaseTurn,
  createOrReuseSupportCase,
  patchSupportCaseLifecycle,
  readSupportCaseForViewer,
} from "../../lib/support/case-service";

const db = jest.mocked(prisma, { shallow: false });
const now = new Date("2026-10-20T00:00:00Z");
const DAY = 86_400_000;
const record = (overrides: Record<string, unknown> = {}) => ({
  id: "case",
  referenceNumber: "FAM-2026-000001",
  title: "Help",
  description: "Complaint",
  category: "GENERAL",
  status: "OPEN",
  caseKind: "INCIDENT",
  activeChannel: "HUMAN",
  priority: "MEDIUM",
  statutoryDueAt: null,
  scopeKey: "ACCOUNT",
  requesterUserId: "customer",
  submitterUserId: "customer",
  ownershipScope: "PERSONAL",
  organizationId: null,
  appointmentId: null,
  problemCaseId: null,
  appealOfDecisionId: null,
  appealOfModerationActionId: null,
  externalRequesterEmail: null,
  assignedToId: null,
  legalHoldAt: null,
  createdAt: now,
  updatedAt: now,
  awaitingUserSince: null,
  pausedSeconds: 0,
  lastMessageAt: now,
  messageSeq: 1,
  deletedAt: null,
  resolvedAt: null,
  closedAt: null,
  csatRating: null,
  messages: [],
  subjects: [],
  events: [],
  ...overrides,
});
const resolved = (overrides: Record<string, unknown> = {}) =>
  record({
    status: "RESOLVED",
    resolvedAt: new Date(now.getTime() - 3 * DAY),
    ...overrides,
  });
const decision = {
  id: "decision-1",
  appealUntil: new Date(now.getTime() + 4 * DAY),
};
const reply = (overrides: Record<string, unknown> = {}) => ({
  caseId: "case",
  authorUserId: "customer",
  sender: "USER" as const,
  body: "This is still broken",
  isInternal: false,
  ...overrides,
});
const eventKinds = () =>
  db.supportCaseEvent.create.mock.calls.map(
    ([args]) => (args as { data: { kind: string } }).data.kind,
  );

beforeEach(() => {
  jest.clearAllMocks();
  db.supportCase.updateMany.mockResolvedValue({ count: 1 });
  db.supportCase.findUnique.mockResolvedValue(record() as never);
  db.supportCase.findUniqueOrThrow.mockResolvedValue({
    messageSeq: 2,
  } as never);
  db.supportCaseMessage.findUnique.mockResolvedValue(null);
  db.supportCaseMessage.create.mockResolvedValue({
    id: "message",
    seq: 2,
  } as never);
  db.supportCaseDecision.findFirst.mockResolvedValue(null);
});

describe("replies on a resolved case", () => {
  it("appends a follow-up without reopening", async () => {
    db.supportCase.findUnique.mockResolvedValueOnce(resolved() as never);
    const result = await appendSupportCaseTurn(reply(), now);
    expect(result).toMatchObject({ ok: true });
    const [args] = db.supportCase.updateMany.mock.calls[0];
    expect(args.data).not.toHaveProperty("status");
    expect(args.data).not.toHaveProperty("resolvedAt");
    expect(args.data).not.toHaveProperty("closedAt");
    expect(eventKinds()).not.toContain("REOPENED");
    expect(db.supportCaseMessage.create).toHaveBeenCalled();
  });

  it('reopens on "This didn\'t fix it" within 14 days when undecided', async () => {
    const row = resolved({ assignedToId: "agent", pausedSeconds: 3600 });
    db.supportCase.findUnique.mockResolvedValueOnce(row as never);
    const result = await appendSupportCaseTurn(reply({ reopen: true }), now);
    expect(result).toMatchObject({ ok: true });
    expect(db.supportCase.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: "RESOLVED",
        resolvedAt: row.resolvedAt,
      }),
      data: expect.objectContaining({
        status: "IN_PROGRESS",
        resolvedAt: null,
        // MEDIUM resolves in 7 days from the reopen; the statutory date is not rewritten.
        resolutionDueAt: new Date(now.getTime() + 7 * DAY),
        pausedSeconds: 0,
      }),
    });
    expect(db.supportCase.updateMany.mock.calls[0][0].data).not.toHaveProperty(
      "statutoryDueAt",
    );
    expect(db.supportCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "REOPENED",
        fromValue: "RESOLVED",
        toValue: "IN_PROGRESS",
      }),
    });
  });

  it("refuses a reopen of a decided case and names the appeal deadline", async () => {
    db.supportCase.findUnique.mockResolvedValueOnce(resolved() as never);
    db.supportCaseDecision.findFirst.mockResolvedValueOnce(decision as never);
    const result = await appendSupportCaseTurn(reply({ reopen: true }), now);
    expect(result).toEqual({
      ok: false,
      status: 409,
      code: "CASE_DECIDED",
      error: expect.any(String),
      appealUntil: decision.appealUntil.toISOString(),
      decisionId: "decision-1",
    });
    expect(db.supportCase.updateMany).not.toHaveBeenCalled();
    expect(db.supportCaseMessage.create).not.toHaveBeenCalled();
  });

  it("refuses a reopen after the 14-day window", async () => {
    db.supportCase.findUnique.mockResolvedValueOnce(
      resolved({ resolvedAt: new Date(now.getTime() - 15 * DAY) }) as never,
    );
    expect(
      await appendSupportCaseTurn(reply({ reopen: true }), now),
    ).toMatchObject({
      ok: false,
      status: 409,
      code: "REOPEN_WINDOW_EXPIRED",
    });
    expect(db.supportCase.updateMany).not.toHaveBeenCalled();
  });

  it("lets only the requester or submitter reopen", async () => {
    db.supportCase.findUnique.mockResolvedValueOnce(resolved() as never);
    expect(
      await appendSupportCaseTurn(
        reply({ reopen: true, authorUserId: "co-operator" }),
        now,
      ),
    ).toMatchObject({ ok: false, status: 403, code: "REOPEN_NOT_ALLOWED" });
    expect(db.supportCase.updateMany).not.toHaveBeenCalled();
  });

  it("ignores the reopen flag on a case that is still open", async () => {
    await appendSupportCaseTurn(reply({ reopen: true }), now);
    const [args] = db.supportCase.updateMany.mock.calls[0];
    expect(args.data).not.toHaveProperty("status");
    expect(eventKinds()).not.toContain("REOPENED");
  });
});

describe("matching intake on a resolved case", () => {
  const intake = {
    title: "Help",
    description: "Still not working",
    category: "GENERAL",
    requesterUserId: "customer",
    submitterUserId: "customer",
    activeChannel: "HUMAN" as const,
  };

  it("appends a follow-up to a resolved human case without status change or handoff", async () => {
    const row = resolved();
    db.supportCase.findFirst.mockResolvedValueOnce(row as never);
    db.supportCase.findUnique.mockResolvedValueOnce(row as never);
    db.supportCase.findUniqueOrThrow
      .mockResolvedValueOnce({ messageSeq: 2 } as never)
      .mockResolvedValueOnce(row as never);
    const result = await createOrReuseSupportCase(intake, now);
    expect(result).toMatchObject({
      reused: true,
      dedupeReason: "resolved_case",
    });
    expect(db.supportCase.updateMany).toHaveBeenCalledTimes(1);
    expect(db.supportCase.updateMany.mock.calls[0][0].data).not.toHaveProperty(
      "status",
    );
    expect(eventKinds()).toEqual([]);
    expect(db.supportCase.create).not.toHaveBeenCalled();
  });

  it("keeps a decided guided case resolved and only appends", async () => {
    const row = resolved({ activeChannel: "SELF_SERVE" });
    db.supportCase.findFirst.mockResolvedValueOnce(row as never);
    db.supportCase.findUnique.mockResolvedValueOnce(row as never);
    db.supportCase.findUniqueOrThrow
      .mockResolvedValueOnce({ messageSeq: 2 } as never)
      .mockResolvedValueOnce(row as never);
    db.supportCaseDecision.findFirst.mockResolvedValueOnce(decision as never);
    const result = await createOrReuseSupportCase(intake, now);
    expect(result.dedupeReason).toBe("resolved_case");
    expect(db.supportCase.updateMany).toHaveBeenCalledTimes(1);
  });

  it("hands an undecided guided answer to a person with status and channel events", async () => {
    const row = resolved({ activeChannel: "SELF_SERVE" });
    db.supportCase.findFirst.mockResolvedValueOnce(row as never);
    db.supportCase.findUnique.mockResolvedValueOnce(row as never);
    db.supportCase.findUniqueOrThrow
      .mockResolvedValueOnce({ messageSeq: 2 } as never)
      .mockResolvedValueOnce(row as never)
      .mockResolvedValueOnce({
        ...row,
        status: "OPEN",
        activeChannel: "HUMAN",
        resolvedAt: null,
      } as never);
    const result = await createOrReuseSupportCase(intake, now);
    expect(result.dedupeReason).toBe("open_scope");
    expect(db.supportCase.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        status: "RESOLVED",
        activeChannel: "SELF_SERVE",
      }),
      data: expect.objectContaining({
        status: "OPEN",
        activeChannel: "HUMAN",
        resolvedAt: null,
      }),
    });
    expect(db.supportCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "STATUS_CHANGED",
        fromValue: "RESOLVED",
        toValue: "OPEN",
      }),
    });
    expect(db.supportCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "CHANNEL_CHANGED",
        fromValue: "SELF_SERVE",
        toValue: "HUMAN",
      }),
    });
  });

  it("records the channel change on a plain guided-conversation handoff", async () => {
    const row = record({ status: "OPEN", activeChannel: "SELF_SERVE" });
    db.supportCase.findFirst.mockResolvedValueOnce(row as never);
    db.supportCase.findUnique.mockResolvedValueOnce(row as never);
    db.supportCase.findUniqueOrThrow
      .mockResolvedValueOnce({ messageSeq: 2 } as never)
      .mockResolvedValueOnce(row as never)
      .mockResolvedValueOnce({ ...row, activeChannel: "HUMAN" } as never);
    await createOrReuseSupportCase(intake, now);
    expect(eventKinds()).toEqual(["CHANNEL_CHANGED"]);
  });
});

describe("staff lifecycle patch", () => {
  const patch = (overrides: Record<string, unknown> = {}) => ({
    caseId: "case",
    actorId: "staff",
    expectedUpdatedAt: now.toISOString(),
    ...overrides,
  });

  it("refuses to reopen a decided case", async () => {
    db.supportCase.findUnique.mockResolvedValueOnce(resolved() as never);
    db.supportCaseDecision.findFirst.mockResolvedValueOnce(decision as never);
    expect(
      await patchSupportCaseLifecycle(patch({ status: "OPEN" }), now),
    ).toMatchObject({
      ok: false,
      status: 409,
      code: "CASE_DECIDED",
      decisionId: "decision-1",
    });
    expect(db.supportCase.updateMany).not.toHaveBeenCalled();
  });

  it("reopens an undecided resolved case with a REOPENED event", async () => {
    db.supportCase.findUnique.mockResolvedValueOnce(resolved() as never);
    db.supportCase.findUniqueOrThrow.mockResolvedValueOnce(
      record({ status: "OPEN" }) as never,
    );
    expect(
      await patchSupportCaseLifecycle(patch({ status: "OPEN" }), now),
    ).toMatchObject({ ok: true });
    expect(eventKinds()).toEqual(["REOPENED"]);
  });

  it("refuses a move the table forbids", async () => {
    db.supportCase.findUnique.mockResolvedValueOnce(
      record({ status: "CLOSED", closedAt: now }) as never,
    );
    expect(
      await patchSupportCaseLifecycle(patch({ status: "RESOLVED" }), now),
    ).toMatchObject({ ok: false, status: 409, code: "INVALID_TRANSITION" });
  });

  it("answers a reopen that collides with a newer open case with that case", async () => {
    const closed = record({ status: "CLOSED", closedAt: now });
    db.$transaction.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    db.supportCase.findUnique.mockResolvedValueOnce(closed as never);
    db.supportCase.findFirst.mockResolvedValueOnce({
      id: "newer",
      referenceNumber: "FAM-2026-000002",
    } as never);
    expect(
      await patchSupportCaseLifecycle(patch({ status: "OPEN" }), now),
    ).toEqual({
      ok: false,
      status: 409,
      code: "OPEN_CASE_EXISTS",
      error: expect.any(String),
      existingCase: {
        id: "newer",
        referenceNumber: "FAM-2026-000002",
        caseKey: "c_newer",
      },
    });
    expect(db.supportCase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scopeKey: "ACCOUNT",
          category: "GENERAL",
          closedAt: null,
          id: { not: "case" },
        }),
      }),
    );
  });

  it("rethrows a unique violation that no open case explains", async () => {
    const failure = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
    });
    db.$transaction.mockRejectedValueOnce(failure);
    db.supportCase.findFirst.mockResolvedValueOnce(null);
    await expect(
      patchSupportCaseLifecycle(patch({ status: "OPEN" }), now),
    ).rejects.toBe(failure);
  });

  it("resolves a problem without touching its incidents and keeps the staff closing message as the event note", async () => {
    db.supportCase.findUnique.mockResolvedValueOnce(
      record({ caseKind: "PROBLEM" }) as never,
    );
    db.supportCase.findUniqueOrThrow.mockResolvedValueOnce(
      record({ caseKind: "PROBLEM", status: "RESOLVED" }) as never,
    );
    db.supportCase.findMany.mockResolvedValueOnce([]);
    const result = await patchSupportCaseLifecycle(
      patch({ status: "RESOLVED", closingMessage: "  Fixed upstream  " }),
      now,
    );
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty("cascadedIncidents");
    expect(db.supportCase.updateMany).toHaveBeenCalledTimes(1);
    expect(db.supportCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "STATUS_CHANGED",
        toValue: "RESOLVED",
        note: "Fixed upstream",
      }),
    });
  });

  it("refuses to link an incident to a resolved problem", async () => {
    db.supportCase.findUnique
      .mockResolvedValueOnce(record() as never)
      .mockResolvedValueOnce({
        id: "problem",
        caseKind: "PROBLEM",
        deletedAt: null,
        status: "RESOLVED",
      } as never);
    expect(
      await patchSupportCaseLifecycle(patch({ problemCaseId: "problem" }), now),
    ).toMatchObject({ ok: false, status: 400, code: "VALIDATION_FAILED" });
    expect(db.supportCase.updateMany).not.toHaveBeenCalled();
  });

  it("places a legal hold on a closed case without reopening it", async () => {
    db.supportCase.findUnique.mockResolvedValueOnce(
      record({ status: "CLOSED", closedAt: now }) as never,
    );
    db.supportCase.findUniqueOrThrow
      .mockResolvedValueOnce({ messageSeq: 2 } as never)
      .mockResolvedValueOnce(record({ status: "CLOSED" }) as never);
    const result = await patchSupportCaseLifecycle(
      patch({ legalHold: true, note: "Litigation notice received" }),
      now,
    );
    expect(result).toMatchObject({ ok: true });
    const [args] = db.supportCase.updateMany.mock.calls[0];
    expect(args.where).not.toHaveProperty("status");
    expect(args.data).toMatchObject({ legalHoldAt: now });
    expect(args.data).not.toHaveProperty("status");
    expect(db.supportCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "LEGAL_HOLD_CHANGED",
        fromValue: "OFF",
        toValue: "ON",
        note: "Litigation notice received",
      }),
    });
  });

  it("lifts a legal hold", async () => {
    db.supportCase.findUnique.mockResolvedValueOnce(
      record({ legalHoldAt: now }) as never,
    );
    db.supportCase.findUniqueOrThrow.mockResolvedValueOnce(record() as never);
    await patchSupportCaseLifecycle(patch({ legalHold: false }), now);
    expect(db.supportCase.updateMany.mock.calls[0][0].data).toMatchObject({
      legalHoldAt: null,
    });
    expect(db.supportCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "LEGAL_HOLD_CHANGED",
        fromValue: "ON",
        toValue: "OFF",
      }),
    });
  });

  it("still refuses other edits on a closed case", async () => {
    db.supportCase.findUnique.mockResolvedValueOnce(
      record({ status: "CLOSED", closedAt: now }) as never,
    );
    expect(
      await patchSupportCaseLifecycle(
        patch({ legalHold: true, priority: "HIGH" }),
        now,
      ),
    ).toMatchObject({ ok: false, status: 400, code: "CASE_CLOSED" });
  });
});

it("keeps channel, legal-hold and purge events off the customer timeline", async () => {
  db.supportCase.findUnique.mockResolvedValueOnce(
    record({
      events: [
        {
          id: "e1",
          kind: "STATUS_CHANGED",
          fromValue: "OPEN",
          toValue: "RESOLVED",
          note: "private",
          createdAt: now,
        },
        {
          id: "e2",
          kind: "CHANNEL_CHANGED",
          fromValue: "SELF_SERVE",
          toValue: "HUMAN",
          createdAt: now,
        },
        {
          id: "e3",
          kind: "LEGAL_HOLD_CHANGED",
          fromValue: "OFF",
          toValue: "ON",
          createdAt: now,
        },
        { id: "e4", kind: "EVIDENCE_PURGED", createdAt: now },
      ],
    }) as never,
  );
  const view = await readSupportCaseForViewer("case", {
    userId: "customer",
    role: "CONSULTEE",
    isStaff: false,
  });
  expect(view?.events).toEqual([
    expect.objectContaining({ id: "e1", kind: "STATUS_CHANGED", note: null }),
  ]);
});
