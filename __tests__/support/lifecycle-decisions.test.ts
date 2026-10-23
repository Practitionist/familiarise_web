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
jest.mock("../../lib/data/public-cache", () => ({
  purgeReviewSurfaces: jest.fn(),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../lib/support/case-access", () => ({
  canCorrespondOnCase: jest.fn(async () => true),
  caseCorrespondentIds: jest.fn(async () => []),
}));
jest.mock("../../lib/support/case-service", () => ({
  executePatchLifecycleTx: jest.fn(async () => ({ ok: true })),
  latestCaseDecisionTx: jest.fn(async () => null),
  caseDecidedDetail: jest.requireActual("../../lib/support/case-service")
    .caseDecidedDetail,
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    supportCase: { findFirst: jest.fn(), updateMany: jest.fn() },
    supportCaseDecision: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    supportCaseEvidenceRequest: { findUnique: jest.fn(), findMany: jest.fn() },
    supportFinancialRecommendation: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    supportCaseSubject: { findFirst: jest.fn(async () => null) },
    payment: { findFirst: jest.fn() },
    moderationAction: { findUnique: jest.fn() },
    supportCaseEvent: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((callback: (tx: typeof db) => unknown) =>
    callback(db),
  );
  return { __esModule: true, default: db };
});

import prisma from "../../lib/prisma";
import {
  executePatchLifecycleTx,
  latestCaseDecisionTx,
} from "../../lib/support/case-service";
import { performCaseAction } from "../../lib/support/case-actions";

const db = jest.mocked(prisma, { shallow: false });
const updatedAt = new Date("2026-10-20T10:00:00Z");
const admin = { userId: "admin-1", role: "ADMIN" as const };
const staff = { userId: "staff-1", role: "STAFF" as const };
const DAY = 86_400_000;
const incident = {
  id: "case-1",
  referenceNumber: "FAM-2026-000001",
  title: "Session problem",
  caseKind: "INCIDENT",
  status: "IN_PROGRESS",
  organizationId: null,
  ownershipScope: "PERSONAL",
  requesterUserId: "customer",
  submitterUserId: "customer",
  appointmentId: "appt-1",
  externalRequesterEmail: null,
  appealOfDecisionId: null,
  appealOfModerationActionId: null,
  statutoryDueAt: null,
  deletedAt: null,
  updatedAt,
};
const appeal = { ...incident, appealOfDecisionId: "original-decision" };
const decide = (overrides: Record<string, unknown> = {}) => ({
  action: "DECIDE" as const,
  clientActionId: "decide-1",
  expectedUpdatedAt: updatedAt.toISOString(),
  outcome: "NO_REMEDY" as const,
  explanation: "We reviewed the session record.",
  ...overrides,
});
const latest = (overrides: Record<string, unknown> = {}) => ({
  id: "decision-1",
  caseId: "case-1",
  decidedById: "staff-9",
  clientActionId: "first",
  outcome: "NO_REMEDY",
  explanation: "First explanation",
  privateRationale: null,
  appealUntil: new Date(Date.now() + 3 * DAY),
  supersedesDecisionId: null,
  createdAt: updatedAt,
  ...overrides,
});
const uniqueViolation = () =>
  Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

beforeEach(() => {
  jest.clearAllMocks();
  db.supportCase.findFirst.mockResolvedValue(incident as never);
  db.supportCase.updateMany.mockResolvedValue({ count: 1 });
  db.supportCaseDecision.findUnique.mockImplementation((async (args: {
    where: { id?: string };
  }) =>
    args.where.id === "original-decision"
      ? { decidedById: "someone-else" }
      : null) as never);
  db.supportCaseDecision.findFirst.mockResolvedValue(null);
  db.supportCaseDecision.create.mockImplementation((async (args: {
    data: Record<string, unknown>;
  }) => ({ id: "decision-new", ...args.data })) as never);
  db.supportCaseEvidenceRequest.findUnique.mockResolvedValue(null);
  db.supportCaseEvidenceRequest.findMany.mockResolvedValue([]);
  db.supportFinancialRecommendation.findUnique.mockResolvedValue(null);
  // A live approved refund exists for REFUND_APPROVED; no approval blocks REFUND_DECLINED.
  db.supportFinancialRecommendation.findFirst.mockImplementation((async (args: {
    where: Record<string, unknown>;
  }) => ("refund" in args.where ? { id: "rec-live" } : null)) as never);
  jest.mocked(latestCaseDecisionTx).mockResolvedValue(null);
  jest.mocked(executePatchLifecycleTx).mockResolvedValue({ ok: true } as never);
});

describe("what a decision may be recorded on", () => {
  it("refuses a decision on a problem record", async () => {
    db.supportCase.findFirst.mockResolvedValue({
      ...incident,
      caseKind: "PROBLEM",
    } as never);
    await expect(
      performCaseAction("case-1", admin, decide()),
    ).rejects.toMatchObject({ code: "DECISION_NOT_ALLOWED", status: 400 });
    expect(executePatchLifecycleTx).not.toHaveBeenCalled();
  });

  it("refuses a decision on a closed case instead of reopening it", async () => {
    db.supportCase.findFirst.mockResolvedValue({
      ...incident,
      status: "CLOSED",
    } as never);
    await expect(
      performCaseAction("case-1", admin, decide()),
    ).rejects.toMatchObject({ code: "CASE_CLOSED", status: 409 });
    expect(executePatchLifecycleTx).not.toHaveBeenCalled();
    expect(db.supportCaseDecision.create).not.toHaveBeenCalled();
  });

  const OUTCOMES = [
    "NO_REMEDY",
    "SERVICE_REMEDY",
    "REFUND_APPROVED",
    "REFUND_DECLINED",
    "UPHELD",
    "OVERTURNED",
  ] as const;
  const APPEAL_ONLY = new Set(["UPHELD", "OVERTURNED"]);
  const matrix = OUTCOMES.flatMap((outcome) =>
    [
      { kind: "incident", row: incident },
      { kind: "appeal", row: appeal },
    ].map(({ kind, row }) => ({
      outcome,
      kind,
      row,
      allowed: (kind === "appeal") === APPEAL_ONLY.has(outcome),
    })),
  );
  it.each(matrix.filter((entry) => entry.allowed))(
    "records $outcome on an $kind",
    async ({ outcome, row }) => {
      db.supportCase.findFirst.mockResolvedValue(row as never);
      await expect(
        performCaseAction("case-1", admin, decide({ outcome })),
      ).resolves.toMatchObject({ outcome });
      expect(executePatchLifecycleTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.not.objectContaining({ closingMessage: expect.anything() }),
        expect.any(Date),
        { actorRole: "ADMIN", freshSession: false },
      );
    },
  );
  it.each(matrix.filter((entry) => !entry.allowed))(
    "refuses $outcome on an $kind",
    async ({ outcome, row }) => {
      db.supportCase.findFirst.mockResolvedValue(row as never);
      await expect(
        performCaseAction("case-1", admin, decide({ outcome })),
      ).rejects.toMatchObject({ code: "OUTCOME_NOT_ALLOWED", status: 400 });
      expect(db.supportCaseDecision.create).not.toHaveBeenCalled();
    },
  );
});

describe("decisions are terminal", () => {
  it("refuses a second decision without an explicit supersede", async () => {
    jest.mocked(latestCaseDecisionTx).mockResolvedValue(latest() as never);
    await expect(
      performCaseAction(
        "case-1",
        admin,
        decide({ clientActionId: "decide-2" }),
      ),
    ).rejects.toMatchObject({
      code: "CASE_ALREADY_DECIDED",
      status: 409,
      detail: { decisionId: "decision-1", appealUntil: expect.any(String) },
    });
    expect(executePatchLifecycleTx).not.toHaveBeenCalled();
  });

  it("answers a lost race on the one-decision index with CASE_ALREADY_DECIDED", async () => {
    db.$transaction.mockRejectedValueOnce(uniqueViolation());
    await expect(
      performCaseAction("case-1", admin, decide()),
    ).rejects.toMatchObject({ code: "CASE_ALREADY_DECIDED", status: 409 });
  });

  it("first decision opens a seven-day appeal window and resolves the case", async () => {
    const before = Date.now();
    await performCaseAction("case-1", admin, decide());
    const created = db.supportCaseDecision.create.mock.calls[0][0].data;
    expect(created.supersedesDecisionId).toBeUndefined();
    expect(
      (created.appealUntil as Date).getTime() - before,
    ).toBeGreaterThanOrEqual(7 * DAY - 1000);
    expect(executePatchLifecycleTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "RESOLVED" }),
      expect.any(Date),
      { actorRole: "ADMIN", freshSession: false },
    );
  });
});

describe("superseding a decision", () => {
  const supersede = (overrides: Record<string, unknown> = {}) =>
    decide({
      clientActionId: "supersede-1",
      outcome: "SERVICE_REMEDY",
      explanation: "Corrected after review.",
      supersedesDecisionId: "decision-1",
      ...overrides,
    });
  beforeEach(() => {
    db.supportCase.findFirst.mockResolvedValue({
      ...incident,
      status: "RESOLVED",
    } as never);
    jest.mocked(latestCaseDecisionTx).mockResolvedValue(latest() as never);
  });

  it("is admin-only", async () => {
    await expect(
      performCaseAction("case-1", staff, supersede()),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("must name the decision in force", async () => {
    await expect(
      performCaseAction(
        "case-1",
        admin,
        supersede({ supersedesDecisionId: "decision-0" }),
      ),
    ).rejects.toMatchObject({
      code: "DECISION_SUPERSEDED",
      detail: { decisionId: "decision-1" },
    });
  });

  it("closes with the original appeal window", async () => {
    jest
      .mocked(latestCaseDecisionTx)
      .mockResolvedValue(
        latest({ appealUntil: new Date(Date.now() - 1000) }) as never,
      );
    await expect(
      performCaseAction("case-1", admin, supersede()),
    ).rejects.toMatchObject({ code: "SUPERSEDE_WINDOW_CLOSED" });
  });

  it("is refused once an appeal was filed on the chain", async () => {
    db.supportCaseDecision.findFirst.mockResolvedValue({
      id: "decision-1",
    } as never);
    await expect(
      performCaseAction("case-1", admin, supersede()),
    ).rejects.toMatchObject({ code: "DECISION_APPEALED" });
    expect(db.supportCaseDecision.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { caseId: "case-1", appeals: { some: {} } },
      }),
    );
  });

  it("inherits the original deadline and leaves the resolution untouched", async () => {
    const original = latest();
    jest.mocked(latestCaseDecisionTx).mockResolvedValue(original as never);
    await performCaseAction("case-1", admin, supersede());
    expect(executePatchLifecycleTx).not.toHaveBeenCalled();
    expect(db.supportCaseDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        appealUntil: original.appealUntil,
        supersedesDecisionId: "decision-1",
        outcome: "SERVICE_REMEDY",
      }),
    });
    const [touch] = db.supportCase.updateMany.mock.calls[0];
    expect(touch.where).toEqual({ id: "case-1", updatedAt });
    expect(Object.keys(touch.data)).toEqual(["updatedAt"]);
    expect(db.supportCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "DECISION_RECORDED",
        fromValue: "decision-1",
        toValue: "decision-new",
      }),
    });
  });

  it("refuses to supersede an approved refund while that refund is live", async () => {
    jest
      .mocked(latestCaseDecisionTx)
      .mockResolvedValue(latest({ outcome: "REFUND_APPROVED" }) as never);
    await expect(
      performCaseAction("case-1", admin, supersede()),
    ).rejects.toMatchObject({ code: "REFUND_APPROVED_EXISTS", status: 409 });
    expect(db.supportFinancialRecommendation.findFirst).toHaveBeenCalledWith({
      where: {
        caseId: "case-1",
        approved: true,
        refund: { status: { in: ["PENDING", "SUCCEEDED"] } },
      },
      select: { id: true },
    });
    expect(db.supportCaseDecision.create).not.toHaveBeenCalled();
  });

  it("supersedes an approved refund once no refund under it is live", async () => {
    jest
      .mocked(latestCaseDecisionTx)
      .mockResolvedValue(latest({ outcome: "REFUND_APPROVED" }) as never);
    db.supportFinancialRecommendation.findFirst.mockResolvedValue(null);
    await expect(
      performCaseAction("case-1", admin, supersede()),
    ).resolves.toMatchObject({
      outcome: "SERVICE_REMEDY",
      supersedesDecisionId: "decision-1",
    });
  });

  it("lets an approved refund be restated with a corrected explanation", async () => {
    jest
      .mocked(latestCaseDecisionTx)
      .mockResolvedValue(latest({ outcome: "REFUND_APPROVED" }) as never);
    await expect(
      performCaseAction(
        "case-1",
        admin,
        supersede({ outcome: "REFUND_APPROVED" }),
      ),
    ).resolves.toMatchObject({ outcome: "REFUND_APPROVED" });
  });

  it("will not silently reinstate a reversed moderation action", async () => {
    db.supportCase.findFirst.mockResolvedValue({
      ...incident,
      status: "RESOLVED",
      appealOfModerationActionId: "moderation-1",
    } as never);
    db.moderationAction.findUnique.mockResolvedValue({
      takenById: "moderator",
    } as never);
    jest
      .mocked(latestCaseDecisionTx)
      .mockResolvedValue(latest({ outcome: "OVERTURNED" }) as never);
    await expect(
      performCaseAction("case-1", admin, supersede({ outcome: "UPHELD" })),
    ).rejects.toMatchObject({ code: "COMPENSATING_ACTION_REQUIRED" });
  });
});

describe("replay fingerprint", () => {
  const storedDecision = (overrides: Record<string, unknown> = {}) => ({
    ...latest({
      clientActionId: "decide-1",
      outcome: "NO_REMEDY",
      explanation: "We reviewed the session record.",
      decidedById: "admin-1",
    }),
    ...overrides,
  });

  it("replays the same decision for the same details", async () => {
    db.supportCaseDecision.findUnique.mockResolvedValue(
      storedDecision() as never,
    );
    await expect(
      performCaseAction("case-1", admin, decide()),
    ).resolves.toMatchObject({ id: "decision-1" });
    expect(executePatchLifecycleTx).not.toHaveBeenCalled();
  });

  it.each([
    ["another outcome", { outcome: "SERVICE_REMEDY" }, admin],
    ["another explanation", { explanation: "Different text" }, admin],
    ["a private rationale added", { privateRationale: "Internal" }, admin],
    ["another actor", {}, { userId: "admin-2", role: "ADMIN" as const }],
  ])("refuses the same key with %s", async (_label, overrides, actor) => {
    db.supportCaseDecision.findUnique.mockResolvedValue(
      storedDecision() as never,
    );
    await expect(
      performCaseAction("case-1", actor, decide(overrides)),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
  });

  it("refuses a key already used by another kind of action", async () => {
    db.supportCaseEvidenceRequest.findUnique.mockResolvedValue({
      id: "evidence-1",
    } as never);
    await expect(
      performCaseAction("case-1", admin, decide()),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(db.supportCaseDecision.create).not.toHaveBeenCalled();
  });

  const recommend = (overrides: Record<string, unknown> = {}) => ({
    action: "RECOMMEND_REFUND" as const,
    clientActionId: "rec-1",
    expectedUpdatedAt: updatedAt.toISOString(),
    paymentId: "pay-1",
    amountPaise: 100_000,
    reason: "Late start",
    releaseSeat: false,
    ...overrides,
  });
  const storedRecommendation = {
    id: "rec-1",
    paymentId: "pay-1",
    amountPaise: BigInt(100_000),
    reason: "Late start",
    releaseSeat: false,
    proposedById: "admin-1",
  };

  it("replays a recommendation whose stored amount matches", async () => {
    db.supportFinancialRecommendation.findUnique.mockResolvedValue(
      storedRecommendation as never,
    );
    await expect(
      performCaseAction("case-1", admin, recommend()),
    ).resolves.toMatchObject({ id: "rec-1" });
    expect(db.supportFinancialRecommendation.create).not.toHaveBeenCalled();
  });

  it("refuses a recommendation replay with another amount", async () => {
    db.supportFinancialRecommendation.findUnique.mockResolvedValue(
      storedRecommendation as never,
    );
    await expect(
      performCaseAction("case-1", admin, recommend({ amountPaise: 90_000 })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("answers a double-submitted recommendation with the winner, not RECOMMENDATION_OPEN", async () => {
    db.$transaction.mockRejectedValueOnce(uniqueViolation());
    db.supportFinancialRecommendation.findUnique.mockResolvedValue(
      storedRecommendation as never,
    );
    await expect(
      performCaseAction("case-1", admin, recommend()),
    ).resolves.toMatchObject({ id: "rec-1" });
  });

  it("still reports an open recommendation when the conflict is another key", async () => {
    db.$transaction.mockRejectedValueOnce(uniqueViolation());
    await expect(
      performCaseAction("case-1", admin, recommend()),
    ).rejects.toMatchObject({ code: "RECOMMENDATION_OPEN" });
  });

  it("refuses an evidence replay addressed to someone else", async () => {
    db.supportCaseEvidenceRequest.findUnique.mockResolvedValue({
      id: "evidence-1",
      recipientUserId: "expert-1",
      prompt: "Share the session notes",
      requestedById: "admin-1",
    } as never);
    await expect(
      performCaseAction("case-1", admin, {
        action: "REQUEST_EVIDENCE",
        clientActionId: "evidence-key",
        expectedUpdatedAt: updatedAt.toISOString(),
        recipientUserId: "expert-2",
        prompt: "Share the session notes",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });
});
