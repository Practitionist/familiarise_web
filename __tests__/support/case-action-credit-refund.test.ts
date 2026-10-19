/**
 * @jest-environment node
 */

/**
 * The credits rail restores a credit-funded booking IN FULL and accepts no
 * amount — `refundBookingPayment` refuses an amount on that rail outright.
 * A support recommendation that approves only PART of the credit would
 * therefore move 100% of it against an approved amount that is smaller, so
 * the approval is refused inside the transaction, before the recommendation
 * is claimed and before any money moves.
 */

type Row = Record<string, unknown>;

type MockState = {
  supportCase: Row | null;
  recommendation: Row | null;
  payment: Row | null;
  claimed: Row[];
  events: Row[];
};

let mockState: MockState;

const mockRefundBookingPayment = jest.fn(async () => ({
  refundId: "refund-1",
  amountRefundedPaise: 5000,
  rail: "CREDITS" as const,
}));

jest.mock("../../lib/prisma", () => {
  const stub = {
    // case-service reads these at import time.
    ALLOCATION_TX_MAX_WAIT_MS: 5_000,
    ALLOCATION_TX_TIMEOUT_MS: 10_000,
    $transaction: async (fn: (tx: unknown) => unknown) => fn(stub),
    supportCase: {
      findFirst: jest.fn(async () => mockState.supportCase),
      findUniqueOrThrow: jest.fn(async () => ({ appointmentId: "appt-1" })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    supportCaseSubject: {
      // No PAYMENT subject on the case, so the payment is matched by the
      // appointment the case hangs off.
      findFirst: jest.fn(async () => null),
    },
    supportFinancialRecommendation: {
      findFirst: jest.fn(async ({ where }: any) => {
        const rec = mockState.recommendation;
        if (!rec) return null;
        if (where?.id !== undefined && rec.id !== where.id) return null;
        if (where?.caseId !== undefined && rec.caseId !== where.caseId)
          return null;
        // The replay probe asks for an ALREADY DECIDED recommendation; an
        // undecided one must not answer it.
        if (where?.decidedAt?.not === null) {
          const decided = rec.decidedAt;
          return decided === null || decided === undefined ? null : rec;
        }
        return rec;
      }),
      findFirstOrThrow: jest.fn(async () => mockState.recommendation),
      updateMany: jest.fn(async ({ where, data }: any) => {
        mockState.claimed.push({ where, data });
        return { count: 1 };
      }),
    },
    supportCaseEvent: {
      create: jest.fn(async ({ data }: any) => {
        mockState.events.push(data);
        return data;
      }),
    },
    payment: {
      findFirst: jest.fn(async () => mockState.payment),
      findUniqueOrThrow: jest.fn(async () => ({
        paymentIntent: mockState.payment?.paymentIntent,
      })),
    },
    membership: { findUnique: jest.fn(async () => null) },
  };
  return { __esModule: true, default: stub };
});

// The payment rails are the heavy module graph; the action only needs to
// know what it asked them to refund.
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: (...args: unknown[]) =>
    mockRefundBookingPayment(...(args as [])),
}));

jest.mock("../../lib/backoffice/refund-doors", () => ({
  __esModule: true,
  refundInFlightOr: async (error: unknown) => {
    throw error;
  },
}));

jest.mock("../../lib/novu/stage-bell", () => ({
  __esModule: true,
  stageBell: jest.fn(async () => null),
}));

import { UserRole } from "@prisma/client";
import { performCaseAction } from "@/lib/support/case-actions";

const ADMIN = { userId: "admin-1", role: UserRole.ADMIN };

const CASE_ID = "case-1";
const RECOMMENDATION_ID = "rec-1";
const PAYMENT_ID = "pay-1";
const CREDIT_AMOUNT_PAISE = 5000;

function seed({
  paymentIntent,
  paymentAmount = CREDIT_AMOUNT_PAISE,
  recommendationAmountPaise,
}: {
  paymentIntent: string;
  paymentAmount?: number;
  recommendationAmountPaise: number;
}) {
  mockState = {
    supportCase: {
      id: CASE_ID,
      referenceNumber: "SUP-1",
      title: "Credit not restored",
      appointmentId: "appt-1",
      submitterUserId: "user-1",
      requesterUserId: "user-1",
      organizationId: null,
      ownershipScope: "PERSONAL",
      statutoryDueAt: null,
      deletedAt: null,
      updatedAt: new Date(),
    },
    recommendation: {
      id: RECOMMENDATION_ID,
      caseId: CASE_ID,
      paymentId: PAYMENT_ID,
      amountPaise: recommendationAmountPaise,
      reason: "goodwill credit",
      decidedAt: null,
      decidedById: null,
      approved: null,
      decisionReason: null,
    },
    payment: {
      id: PAYMENT_ID,
      appointmentId: "appt-1",
      amount: paymentAmount,
      paymentIntent,
      deletedAt: null,
      refunds: [],
      disputes: [],
    },
    claimed: [],
    events: [],
  };
}

function review(approve: boolean, expectedRefundablePaise: number) {
  return {
    action: "REVIEW_REFUND" as const,
    clientActionId: "act-1",
    expectedUpdatedAt: new Date().toISOString(),
    recommendationId: RECOMMENDATION_ID,
    approve,
    reason: "support review",
    expectedRefundablePaise,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("performCaseAction — REVIEW_REFUND on the credits rail", () => {
  it("refuses a partial approval, because the credits rail restores the whole credit", async () => {
    seed({
      paymentIntent: "free_credits_abc",
      recommendationAmountPaise: 1500, // 30% of the credit
    });

    await expect(
      performCaseAction(CASE_ID, ADMIN, review(true, CREDIT_AMOUNT_PAISE)),
    ).rejects.toMatchObject({
      name: "CaseActionError",
      code: "PARTIAL_CREDIT_REFUND_UNSUPPORTED",
    });

    // Nothing moved and the recommendation was not claimed.
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    expect(mockState.claimed).toHaveLength(0);
    expect(mockState.events).toHaveLength(0);
  });

  it("approves a full-credit recommendation and restores the whole credit", async () => {
    seed({
      paymentIntent: "free_credits_abc",
      recommendationAmountPaise: CREDIT_AMOUNT_PAISE,
    });

    const result = await performCaseAction(
      CASE_ID,
      ADMIN,
      review(true, CREDIT_AMOUNT_PAISE),
    );

    expect(result).toMatchObject({ approved: true });
    expect(mockRefundBookingPayment).toHaveBeenCalledTimes(1);
    const [args] = mockRefundBookingPayment.mock.calls[0] as [
      Record<string, unknown>,
    ];
    // The credits rail takes no amount — it restores the credit whole.
    expect(args).not.toHaveProperty("amountPaise");
    expect(args).toMatchObject({
      paymentId: PAYMENT_ID,
      supportRecommendationId: RECOMMENDATION_ID,
    });
  });

  it("still allows a partial approval on a gateway-funded booking", async () => {
    seed({
      paymentIntent: "pay_abc",
      recommendationAmountPaise: 1500,
    });

    await performCaseAction(CASE_ID, ADMIN, review(true, CREDIT_AMOUNT_PAISE));

    expect(mockRefundBookingPayment).toHaveBeenCalledTimes(1);
    const [args] = mockRefundBookingPayment.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(args.amountPaise).toBe(1500);
  });
});
