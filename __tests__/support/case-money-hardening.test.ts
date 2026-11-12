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
jest.mock("../../lib/booking/plan-refund", () => ({
  ...jest.requireActual("../../lib/booking/plan-refund"),
  removePlanSessions: jest.fn(async () => ({ ok: true, sessionsRefunded: 9 })),
  restorePlanSessions: jest.fn(async () => ({ ok: true, sessionsRefunded: 0 })),
}));
jest.mock("../../lib/support/case-service", () => ({
  executePatchLifecycleTx: jest.fn(),
  latestCaseDecisionTx: jest.fn(async () => null),
  caseDecidedDetail: jest.fn(() => ({})),
}));

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function mockMatches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, want]) => {
    if (want === undefined) return true;
    if (key === "OR") return (want as Where[]).some((w) => mockMatches(row, w));
    const value = row[key];
    if (want === null) return value === null || value === undefined;
    if (typeof want === "object" && !(want instanceof Date)) {
      const filter = want as Where;
      if ("not" in filter) return value !== filter.not;
      if ("in" in filter) return (filter.in as unknown[]).includes(value);
      if ("lte" in filter)
        return value instanceof Date && value <= (filter.lte as Date);
      return (
        value !== null &&
        value !== undefined &&
        mockMatches(value as Row, filter)
      );
    }
    return value === want;
  });
}

const mockStore = {
  recommendations: [] as Row[],
  events: [] as Row[],
  opsRows: [] as Row[],
  admins: 1,
  payment: {} as Row,
  keyedRefund: null as Row | null,
  refunds: [] as Row[],
  creditUsedPaise: 0,
};

jest.mock("../../lib/prisma", () => {
  const recs = () => mockStore.recommendations;
  const db = {
    supportCase: {
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    supportCaseSubject: { findFirst: jest.fn(async () => null) },
    supportCaseDecision: { findUnique: jest.fn() },
    supportCaseEvidenceRequest: { findUnique: jest.fn(async () => null) },
    moderationAction: { findUnique: jest.fn() },
    supportCaseEvent: {
      findFirst: jest.fn(
        async ({ where }: { where: Where }) =>
          mockStore.events.find((e) =>
            mockMatches(e, { ...where, createdAt: undefined }),
          ) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        mockStore.events.push(data);
        return { id: `evt-${mockStore.events.length}`, ...data };
      }),
    },
    supportFinancialRecommendation: {
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(
        async ({ where }: { where: Where }) =>
          recs().find((r) => mockMatches(r, where)) ?? null,
      ),
      findFirstOrThrow: jest.fn(async ({ where }: { where: Where }) => {
        const row = recs().find((r) => mockMatches(r, where));
        if (!row) throw new Error("not found");
        return row;
      }),
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        recs().filter((r) => mockMatches(r, where)),
      ),
      updateMany: jest.fn(
        async ({ where, data }: { where: Where; data: Row }) => {
          const hit = recs().filter((r) => mockMatches(r, where));
          hit.forEach((r) => Object.assign(r, data));
          return { count: hit.length };
        },
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: "rec-new", decidedAt: null, ...data };
        recs().push(row);
        return row;
      }),
    },
    payment: { findFirst: jest.fn(async () => mockStore.payment) },
    refund: {
      findFirst: jest.fn(async () => mockStore.keyedRefund),
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        mockStore.refunds.filter((r) =>
          mockMatches(r, { ...where, supportRecommendation: undefined }),
        ),
      ),
    },
    opsActionLog: { findMany: jest.fn(async () => mockStore.opsRows) },
    user: { count: jest.fn(async () => mockStore.admins) },
    referralCreditUsage: {
      aggregate: jest.fn(async () => ({
        _sum: { amount: mockStore.creditUsedPaise },
      })),
    },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((callback: (tx: typeof db) => unknown) =>
    callback(db),
  );
  return { __esModule: true, default: db };
});

import prisma from "../../lib/prisma";
import { refundBookingPayment } from "../../lib/payments/operations/booking-refund";
import {
  executePatchLifecycleTx,
  latestCaseDecisionTx,
} from "../../lib/support/case-service";
import { requiresSecondApprover } from "../../lib/backoffice/ops-proposals";
import {
  removePlanSessions,
  restorePlanSessions,
} from "../../lib/booking/plan-refund";
import {
  CaseActionRequestSchema,
  performCaseAction,
  priceCaseRefundReview,
} from "../../lib/support/case-actions";

const db = jest.mocked(prisma, { shallow: false });
const caseUpdatedAt = new Date("2026-10-20T10:00:00Z");
const admin = { userId: "admin-2", role: "ADMIN" as const };
const staff = { userId: "staff-1", role: "STAFF" as const };
const supportCase = {
  id: "case-1",
  referenceNumber: "FAM-2026-000001",
  title: "Refund help",
  organizationId: null,
  ownershipScope: "PERSONAL",
  requesterUserId: "customer",
  submitterUserId: "customer",
  appointmentId: "appt-1",
  externalRequesterEmail: null,
  appealOfDecisionId: null,
  appealOfModerationActionId: null,
  deletedAt: null,
  updatedAt: caseUpdatedAt,
};

function recommendation(over: Row = {}): Row {
  return {
    id: "rec-1",
    caseId: "case-1",
    paymentId: "pay-1",
    proposedById: "staff-author",
    amountPaise: 300_000,
    reason: "Internal narrative that must not reach the gateway",
    decidedAt: null,
    decidedById: null,
    approved: null,
    releaseSeat: false,
    voidedAt: null,
    refundId: null,
    refund: null,
    payment: { paymentIntent: "pi_1" },
    supportCase: { referenceNumber: "FAM-2026-000001" },
    ...over,
  };
}

const review = (approve: boolean, over: Row = {}) => ({
  action: "REVIEW_REFUND" as const,
  clientActionId: "review-1",
  expectedUpdatedAt: caseUpdatedAt.toISOString(),
  recommendationId: "rec-1",
  approve,
  reason: "Checked the session record",
  expectedRefundablePaise: 1_000_000,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.recommendations = [recommendation()];
  mockStore.events = [];
  mockStore.opsRows = [];
  mockStore.admins = 1;
  mockStore.keyedRefund = null;
  mockStore.refunds = [];
  mockStore.creditUsedPaise = 0;
  mockStore.payment = {
    id: "pay-1",
    amount: 1_000_000,
    paymentIntent: "pi_1",
    paymentStatus: "SUCCEEDED",
    refunds: [],
    disputes: [],
  };
  db.supportCase.findFirst.mockResolvedValue(supportCase as never);
  db.supportCase.findUniqueOrThrow.mockResolvedValue(supportCase as never);
  jest.mocked(refundBookingPayment).mockResolvedValue({
    refundId: "refund-1",
    amountRefundedPaise: 300_000,
    rail: "GATEWAY",
    status: "PENDING",
  });
});

describe("bounded staff refunds", () => {
  it("lets staff execute a remedy within the per-payment and rolling limits", async () => {
    const result = await performCaseAction("case-1", staff, review(true));
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay-1",
        amountPaise: 300_000,
        reason: "Support remedy FAM-2026-000001",
        dedupeKey: "case-recommendation:rec-1",
        keepSeat: true,
      }),
    );
    expect(result).toMatchObject({ movedPaise: 300_000 });
    expect(mockStore.events).toContainEqual(
      expect.objectContaining({
        kind: "RECOMMENDATION_DECIDED",
        toValue: "rec-1",
      }),
    );
  });

  it("counts the payment's other approved remedies toward the ₹5,000 staff limit", async () => {
    mockStore.recommendations.push(
      recommendation({
        id: "rec-0",
        decidedAt: new Date(),
        approved: true,
        refund: { id: "refund-0", status: "SUCCEEDED" },
        refundId: "refund-0",
      }),
    );
    mockStore.payment.refunds = [{ amountPaise: 300_000, status: "SUCCEEDED" }];
    await expect(
      performCaseAction(
        "case-1",
        staff,
        review(true, { expectedRefundablePaise: 700_000 }),
      ),
    ).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    expect(db.supportFinancialRecommendation.updateMany).not.toHaveBeenCalled();
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it("counts a live non-remedy refund, such as a platform cancel, toward the ₹5,000 staff limit", async () => {
    const cancelRefund = {
      paymentId: "pay-1",
      amountPaise: 300_000,
      status: "SUCCEEDED",
      deletedAt: null,
    };
    mockStore.refunds = [cancelRefund];
    mockStore.payment.refunds = [cancelRefund];
    await expect(
      performCaseAction(
        "case-1",
        staff,
        review(true, { expectedRefundablePaise: 700_000 }),
      ),
    ).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it("refuses staff once their ops-log refunds reach ₹50,000 in 24 hours", async () => {
    mockStore.opsRows = [
      { after: { movedPaise: 4_000_000 } },
      { after: { movedPaise: 900_000 } },
      { after: { status: "FAILED", code: "GATEWAY_REFUND_FAILED" } },
    ];
    await expect(
      performCaseAction("case-1", staff, review(true)),
    ).rejects.toMatchObject({ code: "STAFF_DAILY_LIMIT" });
    expect(db.opsActionLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorUserId: "staff-1" }),
      }),
    );
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it("counts a credit restoration at the referral credit it returns", async () => {
    mockStore.payment = {
      ...mockStore.payment,
      amount: 0,
      paymentIntent: "free_1",
    };
    mockStore.recommendations = [
      recommendation({ amountPaise: 0, payment: { paymentIntent: "free_1" } }),
    ];
    mockStore.creditUsedPaise = 600_000;
    await expect(
      performCaseAction(
        "case-1",
        staff,
        review(true, { expectedRefundablePaise: 0 }),
      ),
    ).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it("lets an admin execute above the staff limits", async () => {
    mockStore.recommendations = [recommendation({ amountPaise: 900_000 })];
    mockStore.opsRows = [{ after: { movedPaise: 4_900_000 } }];
    await performCaseAction("case-1", admin, review(true));
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 900_000 }),
    );
  });
});

describe("maker and checker", () => {
  it("refuses the author's own approval while two admins are active", async () => {
    mockStore.recommendations = [recommendation({ proposedById: "admin-2" })];
    mockStore.admins = 2;
    await expect(
      performCaseAction("case-1", admin, review(true)),
    ).rejects.toMatchObject({ code: "SAME_AUTHOR" });
    mockStore.admins = 1;
    await expect(
      performCaseAction("case-1", admin, review(true)),
    ).resolves.toMatchObject({ approved: true });
  });

  it("prices a split remedy cumulatively, so the second-admin threshold still applies", async () => {
    mockStore.payment.amount = 10_000_000;
    mockStore.recommendations = [
      recommendation({ amountPaise: 1_000_000 }),
      recommendation({
        id: "rec-0",
        amountPaise: 2_000_000,
        decidedAt: new Date(),
        approved: true,
      }),
    ];
    const price = await priceCaseRefundReview(db as never, "case-1", admin, {
      recommendationId: "rec-1",
      approve: true,
    });
    expect(price).toBe(3_000_000);
    expect(
      await requiresSecondApprover(
        { user: { count: async () => 2 } } as never,
        price,
      ),
    ).toBe(true);
    await expect(
      performCaseAction(
        "case-1",
        admin,
        review(true, { expectedRefundablePaise: 10_000_000 }),
      ),
    ).rejects.toMatchObject({ code: "PREVIEW_CHANGED" });
    await performCaseAction(
      "case-1",
      admin,
      review(true, { expectedRefundablePaise: 8_000_000 }),
    );
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
  });
});

describe("refund execution correctness", () => {
  it("keeps the seat by default and releases it only when the remedy says so", async () => {
    await performCaseAction("case-1", admin, review(true));
    expect(refundBookingPayment).toHaveBeenLastCalledWith(
      expect.objectContaining({ keepSeat: true }),
    );
    mockStore.recommendations = [recommendation({ releaseSeat: true })];
    await performCaseAction("case-1", admin, review(true));
    expect(refundBookingPayment).toHaveBeenLastCalledWith(
      expect.objectContaining({ keepSeat: false }),
    );
  });

  it("leaves a failed refund's retry to the administrator who approved it", async () => {
    mockStore.recommendations = [
      recommendation({
        decidedAt: new Date(),
        decidedById: "admin-1",
        approved: true,
        refundId: "refund-0",
        refund: { id: "refund-0", status: "FAILED" },
      }),
    ];
    await expect(
      performCaseAction("case-1", admin, review(true)),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(refundBookingPayment).not.toHaveBeenCalled();
    expect(db.supportFinancialRecommendation.updateMany).not.toHaveBeenCalled();
  });

  it("replays a second-admin approval after a case message moved the case version", async () => {
    await expect(
      performCaseAction(
        "case-1",
        admin,
        review(true, { expectedUpdatedAt: "2026-10-19T08:00:00.000Z" }),
      ),
    ).resolves.toMatchObject({ approved: true });
    expect(db.supportCase.updateMany).not.toHaveBeenCalled();
    expect(db.supportFinancialRecommendation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rec-1", decidedAt: null },
      }),
    );
  });

  it("refuses approval while a chargeback is live, before claiming the decision", async () => {
    mockStore.payment.disputes = [{ amountPaise: 1_000_000, status: "OPEN" }];
    await expect(
      performCaseAction("case-1", admin, review(true)),
    ).rejects.toMatchObject({ code: "REFUND_BLOCKED_BY_DISPUTE" });
    expect(db.supportFinancialRecommendation.updateMany).not.toHaveBeenCalled();
  });

  it("refuses approval of a payment that is not captured", async () => {
    mockStore.payment.paymentStatus = "PENDING";
    await expect(
      performCaseAction("case-1", admin, review(true)),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_SUCCEEDED" });
  });

  it("retries a FAILED refund as new money and replays a live one for free", async () => {
    mockStore.recommendations = [
      recommendation({
        decidedAt: new Date(),
        decidedById: admin.userId,
        approved: true,
        refundId: "refund-0",
        refund: { id: "refund-0", status: "FAILED" },
      }),
    ];
    const retried = await performCaseAction("case-1", admin, review(true));
    expect(retried).toMatchObject({ movedPaise: 300_000 });
    expect(db.supportFinancialRecommendation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rec-1", approved: true, voidedAt: null },
      }),
    );
    expect(mockStore.events).toContainEqual(
      expect.objectContaining({
        kind: "RECOMMENDATION_DECIDED",
        toValue: "rec-1",
        note: "RETRIED",
      }),
    );
    expect(
      await priceCaseRefundReview(db as never, "case-1", admin, {
        recommendationId: "rec-1",
        approve: true,
      }),
    ).toBe(300_000);

    mockStore.recommendations[0].refund = { id: "refund-1", status: "PENDING" };
    const replayed = await performCaseAction("case-1", admin, review(true));
    expect(replayed).toMatchObject({ movedPaise: 0 });
    expect(
      await priceCaseRefundReview(db as never, "case-1", admin, {
        recommendationId: "rec-1",
        approve: true,
      }),
    ).toBe(0);
  });

  it("lets an admin void an approval whose refund failed, with a typed event", async () => {
    mockStore.recommendations = [
      recommendation({
        decidedAt: new Date(),
        approved: true,
        refundId: "refund-0",
        refund: { id: "refund-0", status: "FAILED" },
      }),
    ];
    const voidAction = {
      action: "VOID_RECOMMENDATION" as const,
      clientActionId: "void-1",
      expectedUpdatedAt: caseUpdatedAt.toISOString(),
      recommendationId: "rec-1",
      reason: "Gateway refused; refunding by bank transfer",
    };
    await expect(
      performCaseAction("case-1", staff, voidAction),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await performCaseAction("case-1", admin, voidAction);
    expect(mockStore.recommendations[0]).toMatchObject({
      approved: false,
      voidedById: "admin-2",
      voidedAt: expect.any(Date),
    });
    expect(mockStore.events).toContainEqual(
      expect.objectContaining({
        kind: "RECOMMENDATION_VOIDED",
        toValue: "rec-1",
      }),
    );
  });

  it("refuses to void an approval whose refund is live", async () => {
    mockStore.recommendations = [
      recommendation({
        decidedAt: new Date(),
        approved: true,
        refundId: "refund-0",
        refund: { id: "refund-0", status: "SUCCEEDED" },
      }),
    ];
    await expect(
      performCaseAction("case-1", admin, {
        action: "VOID_RECOMMENDATION",
        clientActionId: "void-1",
        expectedUpdatedAt: caseUpdatedAt.toISOString(),
        recommendationId: "rec-1",
        reason: "Changed my mind",
      }),
    ).rejects.toMatchObject({ code: "NOT_VOIDABLE" });
  });

  it("refuses to void an unlinked approval that may still be sending its refund", async () => {
    const voidAction = {
      action: "VOID_RECOMMENDATION" as const,
      clientActionId: "void-1",
      expectedUpdatedAt: caseUpdatedAt.toISOString(),
      recommendationId: "rec-1",
      reason: "Refund never arrived",
    };
    mockStore.recommendations = [
      recommendation({ decidedAt: new Date(), approved: true }),
    ];
    await expect(
      performCaseAction("case-1", admin, voidAction),
    ).rejects.toMatchObject({ code: "NOT_VOIDABLE" });

    const stale = () =>
      recommendation({
        decidedAt: new Date(Date.now() - 3_600_000),
        approved: true,
      });
    mockStore.recommendations = [stale()];
    mockStore.keyedRefund = { id: "refund-reserved" };
    await expect(
      performCaseAction("case-1", admin, voidAction),
    ).rejects.toMatchObject({ code: "NOT_VOIDABLE" });
    expect(db.refund.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dedupeKey: "case-recommendation:rec-1",
        }),
      }),
    );

    mockStore.recommendations = [stale()];
    mockStore.keyedRefund = null;
    await performCaseAction("case-1", admin, voidAction);
    expect(mockStore.recommendations[0]).toMatchObject({ approved: false });
  });

  /** An approved remedy whose refund failed an hour ago. */
  const failedRemedy = (over: Row = {}) =>
    recommendation({
      decidedAt: new Date(Date.now() - 3_600_000),
      approved: true,
      sessionsRemoved: 9,
      refundId: "refund-0",
      refund: { id: "refund-0", status: "FAILED" },
      ...over,
    });
  const voidRemedy = () =>
    performCaseAction("case-1", admin, {
      action: "VOID_RECOMMENDATION",
      clientActionId: "void-1",
      expectedUpdatedAt: caseUpdatedAt.toISOString(),
      recommendationId: "rec-1",
      reason: "Gateway refused; refunding by bank transfer",
    });

  it("gives a session-count remedy's sessions back when its failed refund is voided", async () => {
    mockStore.recommendations = [failedRemedy()];
    await voidRemedy();
    expect(mockStore.recommendations[0]).toMatchObject({ approved: false });
    expect(restorePlanSessions).toHaveBeenCalledTimes(1);
    expect(restorePlanSessions).toHaveBeenCalledWith(
      expect.anything(),
      "pay-1",
      9,
    );
  });

  it.each([
    ["the plan's session count moved under it", "RACED", "CONFLICT"],
    ["its plan settled without it", "PLAN_SETTLED", "NOT_VOIDABLE"],
  ] as const)("refuses the void when %s", async (_why, reason, code) => {
    jest
      .mocked(restorePlanSessions)
      .mockResolvedValueOnce({ ok: false, reason, removable: 0 });
    mockStore.recommendations = [failedRemedy()];
    await expect(voidRemedy()).rejects.toMatchObject({ code });
  });

  it("voids a money-only remedy without touching the plan", async () => {
    mockStore.recommendations = [failedRemedy({ sessionsRemoved: null })];
    await voidRemedy();
    expect(restorePlanSessions).not.toHaveBeenCalled();
  });

  it("removes a session-count remedy's sessions in the approval, not on a retry", async () => {
    mockStore.recommendations = [recommendation({ sessionsRemoved: 9 })];
    await performCaseAction("case-1", admin, review(true));
    expect(removePlanSessions).toHaveBeenCalledWith(
      expect.anything(),
      "pay-1",
      9,
    );
    jest.mocked(removePlanSessions).mockClear();
    mockStore.recommendations = [failedRemedy({ decidedById: admin.userId })];
    await performCaseAction("case-1", admin, review(true));
    expect(removePlanSessions).not.toHaveBeenCalled();
  });

  it("retries a session-count remedy after its plan settled, under the same key", async () => {
    mockStore.recommendations = [failedRemedy({ decidedById: admin.userId })];
    await performCaseAction("case-1", admin, review(true));
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: "case-recommendation:rec-1" }),
    );
    expect(removePlanSessions).not.toHaveBeenCalled();
  });

  it("refuses an approval when the plan closed after the recommendation", async () => {
    jest.mocked(removePlanSessions).mockResolvedValueOnce({
      ok: false,
      reason: "PLAN_CLOSED",
      removable: 0,
    });
    mockStore.recommendations = [recommendation({ sessionsRemoved: 9 })];
    await expect(
      performCaseAction("case-1", admin, review(true)),
    ).rejects.toMatchObject({ code: "INVALID_SESSIONS" });
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it("keeps a void and a retry of the same failed refund mutually exclusive", async () => {
    const failed = () =>
      recommendation({
        decidedAt: new Date(Date.now() - 3_600_000),
        decidedById: admin.userId,
        approved: true,
        refundId: "refund-0",
        refund: { id: "refund-0", status: "FAILED" },
      });
    mockStore.recommendations = [failed()];
    await performCaseAction("case-1", admin, review(true));
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);

    mockStore.recommendations = [failed()];
    await expect(
      performCaseAction("case-1", admin, {
        action: "VOID_RECOMMENDATION",
        clientActionId: "void-1",
        expectedUpdatedAt: caseUpdatedAt.toISOString(),
        recommendationId: "rec-1",
        reason: "Refunding by bank transfer instead",
      }),
    ).rejects.toMatchObject({ code: "NOT_VOIDABLE" });

    mockStore.events = [];
    mockStore.recommendations = [failed()];
    db.supportFinancialRecommendation.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    await expect(
      performCaseAction("case-1", admin, review(true)),
    ).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
  });

  it("allows one open recommendation per payment and keeps the seat by default", async () => {
    const recommend = {
      action: "RECOMMEND_REFUND" as const,
      clientActionId: "rec-a",
      expectedUpdatedAt: caseUpdatedAt.toISOString(),
      paymentId: "pay-1",
      amountPaise: 100_000,
      reason: "Late start",
      releaseSeat: false,
    };
    await expect(
      performCaseAction("case-1", staff, recommend),
    ).rejects.toMatchObject({ code: "RECOMMENDATION_OPEN" });
    mockStore.recommendations = [];
    await performCaseAction("case-1", staff, recommend);
    expect(db.supportFinancialRecommendation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ releaseSeat: false }),
    });
    expect(mockStore.events).toContainEqual(
      expect.objectContaining({ kind: "RECOMMENDATION_PROPOSED" }),
    );
  });
});

describe("refund decisions follow the money", () => {
  const decide = (outcome: "REFUND_APPROVED" | "REFUND_DECLINED") => ({
    action: "DECIDE" as const,
    clientActionId: `decide-${outcome}`,
    expectedUpdatedAt: caseUpdatedAt.toISOString(),
    outcome,
    explanation: "Decision explained to the customer",
  });

  it("refuses REFUND_APPROVED without an approved, live refund", async () => {
    await expect(
      performCaseAction("case-1", staff, decide("REFUND_APPROVED")),
    ).rejects.toMatchObject({ code: "REFUND_NOT_LIVE" });
    expect(executePatchLifecycleTx).not.toHaveBeenCalled();
  });

  it("refuses REFUND_DECLINED while an approval stands", async () => {
    mockStore.recommendations = [
      recommendation({ decidedAt: new Date(), approved: true }),
    ];
    await expect(
      performCaseAction("case-1", staff, decide("REFUND_DECLINED")),
    ).rejects.toMatchObject({ code: "REFUND_APPROVED_EXISTS" });
    expect(executePatchLifecycleTx).not.toHaveBeenCalled();
  });

  it("keeps a decision and an open recommendation apart, since deciding releases the holds", async () => {
    await expect(
      performCaseAction("case-1", staff, {
        ...decide("REFUND_DECLINED"),
        outcome: "NO_REMEDY",
      }),
    ).rejects.toMatchObject({ code: "RECOMMENDATION_OPEN" });
    expect(executePatchLifecycleTx).not.toHaveBeenCalled();
    jest.mocked(latestCaseDecisionTx).mockResolvedValueOnce({
      id: "dec-1",
      outcome: "NO_REMEDY",
      appealUntil: new Date(),
    } as never);
    await expect(
      performCaseAction("case-1", admin, review(true)),
    ).rejects.toMatchObject({ code: "CASE_ALREADY_DECIDED" });
    expect(refundBookingPayment).not.toHaveBeenCalled();
    await expect(
      performCaseAction("case-1", admin, review(false)),
    ).resolves.toMatchObject({ approved: false });
  });
});

describe("the action contract", () => {
  const base = {
    clientActionId: "a-1",
    expectedUpdatedAt: caseUpdatedAt.toISOString(),
  };

  it("rejects the removed HANDOVER action", () => {
    expect(
      CaseActionRequestSchema.safeParse({
        ...base,
        action: "HANDOVER",
        reason: "Hand to the org",
      }).success,
    ).toBe(false);
  });

  it("requires the previewed refundable balance on approval only", () => {
    const approve = CaseActionRequestSchema.safeParse({
      ...review(true),
      expectedRefundablePaise: undefined,
    });
    expect(approve.success).toBe(false);
    expect(approve.error?.issues[0]?.message).toBe(
      "Refresh the refund preview before approving.",
    );
    expect(
      CaseActionRequestSchema.safeParse({
        ...review(false),
        expectedRefundablePaise: undefined,
      }).success,
    ).toBe(true);
  });
});
