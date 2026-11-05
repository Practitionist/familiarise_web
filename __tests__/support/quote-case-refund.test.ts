/** @jest-environment node */
/**
 * The refund quote a support remedy is approved against: the refundable
 * balance less other approved remedies with no live refund, the remedies
 * already committed on the payment, and any blocker.
 */
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBells: jest.fn(async () => []),
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
    const value = row[key];
    if (want === null) return value === null || value === undefined;
    if (typeof want === "object" && !(want instanceof Date)) {
      const filter = want as Where;
      if ("not" in filter) return value !== filter.not;
      if ("in" in filter) return (filter.in as unknown[]).includes(value);
      return false;
    }
    return value === want;
  });
}

const mockStore = {
  recommendations: [] as Row[],
  payment: {} as Row,
  /** Live refunds on the payment that no support remedy owns (cancels, direct refunds). */
  nonRemedyRefunds: [] as Row[],
};

jest.mock("../../lib/prisma", () => {
  const db = {
    supportCase: {
      findUniqueOrThrow: jest.fn(async () => ({
        appointmentId: "appt-1",
        requesterUserId: "customer",
        ownershipScope: "PERSONAL",
        organizationId: null,
      })),
    },
    supportCaseSubject: { findFirst: jest.fn(async () => null) },
    supportFinancialRecommendation: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        mockStore.recommendations.filter((r) => mockMatches(r, where)),
      ),
    },
    payment: { findFirst: jest.fn(async () => mockStore.payment) },
    refund: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        mockStore.nonRemedyRefunds.filter((r) =>
          mockMatches(r, { paymentId: where.paymentId }),
        ),
      ),
    },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((callback: (tx: typeof db) => unknown) =>
    callback(db),
  );
  return { __esModule: true, default: db };
});

import prisma from "../../lib/prisma";
import { quoteCaseRefund } from "../../lib/support/case-actions";

const db = jest.mocked(prisma, { shallow: false });

function remedy(over: Row = {}): Row {
  return {
    id: "rec-1",
    paymentId: "pay-1",
    amountPaise: 300_000,
    approved: null,
    voidedAt: null,
    refund: null,
    ...over,
  };
}

const quote = () =>
  prisma.$transaction((tx) =>
    quoteCaseRefund(tx, "case-1", { id: "rec-1", paymentId: "pay-1" }),
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.recommendations = [remedy()];
  mockStore.nonRemedyRefunds = [];
  mockStore.payment = {
    id: "pay-1",
    amount: 1_000_000,
    paymentIntent: "pi_1",
    paymentStatus: "SUCCEEDED",
    refunds: [],
    disputes: [],
  };
});

describe("quoteCaseRefund committedPaise", () => {
  it("excludes the recommendation being priced, even once approved", async () => {
    mockStore.recommendations = [remedy({ approved: true })];
    const result = await quote();
    expect(result.committedPaise).toBe(0);
    expect(result.refundablePaise).toBe(1_000_000);
    expect(db.supportFinancialRecommendation.findMany).toHaveBeenCalledWith({
      where: {
        paymentId: { in: ["pay-1"] },
        approved: true,
        id: { not: "rec-1" },
      },
      select: { paymentId: true, amountPaise: true },
    });
  });

  it("adds live refunds that no remedy owns, such as a platform cancel", async () => {
    mockStore.recommendations.push(
      remedy({ id: "rec-2", approved: true, amountPaise: 100_000 }),
    );
    mockStore.nonRemedyRefunds = [{ paymentId: "pay-1", amountPaise: 250_000 }];
    expect((await quote()).committedPaise).toBe(350_000);
  });

  it("counts other approved remedies whatever their refund state", async () => {
    mockStore.recommendations.push(
      remedy({ id: "rec-2", approved: true, amountPaise: 100_000 }),
      remedy({
        id: "rec-3",
        approved: true,
        amountPaise: 50_000,
        refund: { status: "SUCCEEDED" },
      }),
      remedy({
        id: "rec-4",
        approved: true,
        amountPaise: 20_000,
        refund: { status: "FAILED" },
      }),
    );
    expect((await quote()).committedPaise).toBe(170_000);
  });

  it("ignores unapproved, declined and voided remedies and other payments", async () => {
    mockStore.recommendations.push(
      remedy({ id: "rec-2", approved: null, amountPaise: 100_000 }),
      remedy({ id: "rec-3", approved: false, amountPaise: 200_000 }),
      remedy({
        id: "rec-4",
        approved: null,
        voidedAt: new Date("2026-10-20T10:00:00Z"),
        amountPaise: 400_000,
      }),
      remedy({
        id: "rec-5",
        paymentId: "pay-2",
        approved: true,
        amountPaise: 800_000,
      }),
    );
    const result = await quote();
    expect(result.committedPaise).toBe(0);
    expect(result.refundablePaise).toBe(1_000_000);
  });
});

describe("quoteCaseRefund edge cases", () => {
  it("prices a zero-amount remedy at nothing", async () => {
    mockStore.recommendations.push(
      remedy({ id: "rec-2", approved: true, amountPaise: 0 }),
    );
    const result = await quote();
    expect(result.committedPaise).toBe(0);
    expect(result.refundablePaise).toBe(1_000_000);
  });

  it("does not count a non-remedy refund on another payment", async () => {
    mockStore.nonRemedyRefunds = [
      { paymentId: "pay-2", amountPaise: 400_000 },
      { paymentId: "pay-1", amountPaise: 100_000 },
    ];
    expect((await quote()).committedPaise).toBe(100_000);
    expect(db.refund.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ paymentId: { in: ["pay-1"] } }),
      }),
    );
  });

  it("quotes the same after the remedy is approved with a PENDING refund", async () => {
    const before = await quote();
    expect(before.refundablePaise).toBe(1_000_000);

    mockStore.recommendations = [
      remedy({ approved: true, refund: { status: "PENDING" } }),
    ];
    mockStore.payment.refunds = [{ amountPaise: 300_000, status: "PENDING" }];
    const first = await quote();
    const second = await quote();

    // The remedy's own refund counts once, in the payment's balance.
    expect(first.refundablePaise).toBe(700_000);
    expect(first.committedPaise).toBe(0);
    expect(second).toEqual(first);
  });
});

describe("quoteCaseRefund refundablePaise", () => {
  it("subtracts only approved other remedies with no live refund", async () => {
    mockStore.payment.refunds = [
      { amountPaise: 50_000, status: "SUCCEEDED" },
      { amountPaise: 30_000, status: "PENDING" },
      { amountPaise: 20_000, status: "FAILED" },
    ];
    mockStore.recommendations = [
      remedy({ approved: true, amountPaise: 999_000 }),
      remedy({ id: "rec-2", approved: true, amountPaise: 100_000 }),
      remedy({
        id: "rec-3",
        approved: true,
        amountPaise: 50_000,
        refund: { status: "SUCCEEDED" },
      }),
      remedy({
        id: "rec-4",
        approved: true,
        amountPaise: 30_000,
        refund: { status: "PENDING" },
      }),
      remedy({
        id: "rec-5",
        approved: true,
        amountPaise: 20_000,
        refund: { status: "FAILED" },
      }),
      remedy({
        id: "rec-6",
        approved: true,
        amountPaise: 10_000,
        refund: { status: "CANCELLED" },
      }),
      remedy({ id: "rec-7", approved: false, amountPaise: 400_000 }),
      remedy({ id: "rec-8", approved: null, amountPaise: 400_000 }),
    ];
    const result = await quote();
    // 1,000,000 gross - 80,000 live refunds - (100,000 + 20,000 + 10,000).
    expect(result.refundablePaise).toBe(790_000);
    expect(result.committedPaise).toBe(210_000);
  });

  it("clamps at zero when unrefunded remedies exceed the balance", async () => {
    mockStore.recommendations.push(
      remedy({ id: "rec-2", approved: true, amountPaise: 1_200_000 }),
    );
    expect((await quote()).refundablePaise).toBe(0);
  });
});

describe("quoteCaseRefund blockers", () => {
  it("is unblocked for a captured payment with no active dispute", async () => {
    mockStore.payment.disputes = [{ amountPaise: 0, status: "WON" }];
    expect((await quote()).blocked).toBeNull();
  });

  it("blocks an uncaptured payment", async () => {
    mockStore.payment.paymentStatus = "PENDING";
    expect((await quote()).blocked).toEqual({
      code: "PAYMENT_NOT_SUCCEEDED",
      reason: "Payment is not captured",
    });
  });

  it("blocks a payment with an active chargeback", async () => {
    mockStore.payment.disputes = [
      { amountPaise: 1_000_000, status: "NEEDS_RESPONSE" },
    ];
    expect((await quote()).blocked).toEqual({
      code: "REFUND_BLOCKED_BY_DISPUTE",
      reason: "A gateway chargeback is active",
    });
  });

  it("reports an uncaptured payment ahead of a chargeback", async () => {
    mockStore.payment.paymentStatus = "FAILED";
    mockStore.payment.disputes = [
      { amountPaise: 1_000_000, status: "UNDER_REVIEW" },
    ];
    expect((await quote()).blocked?.code).toBe("PAYMENT_NOT_SUCCEEDED");
  });
});
