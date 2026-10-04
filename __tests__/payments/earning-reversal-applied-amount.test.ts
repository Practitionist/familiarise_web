/**
 * @jest-environment node
 */

/**
 * #Bugfix — callers must post the APPLIED reversal, not the REQUESTED one.
 *
 * `applyCappedEarningReversal` returns `reversedPaise`, which is `<= request`:
 * it clamps to `share - refundedShareAmount`, and on a lost race it re-reads and
 * takes only the residual. Every caller used to post its ledger journal and its
 * `recordTdsReversal(...)` from its own requested figure, so after a partial
 * application the books claimed paise the earning never absorbed — which is
 * exactly what `reconcile-ledgers` raises as EARNINGS_LEDGER_DRIFT (and an
 * append-only journal cannot be repaired).
 *
 * Driven through the free_ credits rail (`reverseFreeCreditSettlement`), whose
 * `payoutId`-bearing row exercises the TDS branch at the same time. The mock
 * scaffolding and the WHERE-honouring earnings fake follow
 * `free-credit-refund.test.ts` / `earning-refund-cas.test.ts`.
 *
 * Pinned here:
 *  - a request above the remaining cap posts the APPLIED paise (journal AND TDS)
 *  - a CAS refused twice (fully-refused) posts nothing: no TDS, no payable debit
 *  - a zero-amount outcome posts nothing — and never a 0-paise posting, which
 *    the real `postLedgerTxn` THROWS on (each posting must be positive paise)
 */

const mockRefundPayment = jest.fn();
const mockApplyReversal = jest.fn();
const mockReverseCredits = jest.fn();
const mockReverseUtilization = jest.fn();
const mockPostLedgerTxn = jest.fn();
const mockAssertEarningTransition = jest.fn();
const mockRecordTdsReversal = jest.fn();
const mockPaymentFindUnique = jest.fn();
const mockFindDeduped = jest.fn(async (..._a: unknown[]) => null as unknown);

type Earn = {
  id: string;
  consultantProfileId: string;
  consultantSharePaise: number;
  refundedShareAmount: number;
  status: string;
  payoutId: string | null;
};

const tx: Record<string, Record<string, jest.Mock>> = {
  appointmentParticipant: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn(),
  },
  referralCreditUsage: { findMany: jest.fn() },
  appointment: { findUnique: jest.fn() },
  appointmentOccurrence: { findMany: jest.fn() },
  refund: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  payment: { findUniqueOrThrow: jest.fn() },
  consultantEarnings: {
    update: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
  },
  organizationEarnings: {
    update: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
  organizationPayout: { update: jest.fn() },
  orgAuditLog: { create: jest.fn() },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findUnique: (...a: unknown[]) => mockPaymentFindUnique(...a),
    },
    refund: {
      findUnique: async () => ({ metadata: { restoredPaise: 118_000 } }),
    },
    $transaction: (fn: (txClient: unknown) => unknown) => fn(tx),
  },
}));

jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));

jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: (...a: unknown[]) => mockRefundPayment(...a),
  findDedupedRefund: (...a: unknown[]) => mockFindDeduped(...a),
  isDedupeKeyConflict: () => false,
  RefundValidationError: class RefundValidationError extends Error {
    constructor(
      message: string,
      public code: string,
    ) {
      super(message);
      this.name = "RefundValidationError";
    }
  },
}));

jest.mock("../../lib/payments/operations/reversal-engine", () => ({
  applyReversal: (...a: unknown[]) => mockApplyReversal(...a),
  // No org earnings in these fixtures, so the clawback never runs — stubbed
  // rather than requireActual'd to keep the module graph out of the suite.
  postPayoutClawback: jest.fn(),
}));

jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: (...a: unknown[]) => mockReverseCredits(...a),
  restoreCreditsForPaymentUpTo: jest.fn(
    async (_p: string, _t: unknown, n: number) => n,
  ),
}));

jest.mock("../../lib/novu", () => ({
  notifyRefundProcessed: jest.fn().mockResolvedValue(null),
  attemptTrigger: jest.fn(),
}));
jest.mock("../../lib/email", () => ({
  EMAIL_BUDGET_MS: { REQUEST: 1 },
  MONEY_EMAIL_TYPES: { REFUND_PROCESSED: "REFUND_PROCESSED" },
  stageRefundProcessedEmail: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../lib/email/send-to-recipients", () => ({
  attemptStaged: jest.fn(),
}));

jest.mock("../../lib/api/organizations/program-helpers", () => ({
  reverseBookingUtilization: (...a: unknown[]) => mockReverseUtilization(...a),
}));

jest.mock("../../lib/payments/payouts/earning-status", () => ({
  assertEarningStatusTransitionLegal: (...a: unknown[]) =>
    mockAssertEarningTransition(...a),
}));

jest.mock("../../lib/payments/tax/tds-service", () => ({
  recordTdsReversal: (...a: unknown[]) => mockRecordTdsReversal(...a),
}));

// Captured, not executed: the balance assertion re-derives what the real
// poster would enforce, so a drift ships as a red test rather than a red
// production reconcile report.
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  mintConsumerCreditNote: jest.fn().mockResolvedValue({
    consumerCreditNoteId: null,
  }),
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (...a: unknown[]) => mockPostLedgerTxn(...a),
}));

import { refundBookingPayment } from "../../lib/payments/operations/booking-refund";

const PAYMENT_ID = "pay-free-1";

/** ₹1,000 + ₹180 GST booking, fully covered by referral credits. */
function settlement(earnings: Earn[]) {
  return {
    originalAmount: 100_000,
    taxAmount: 18_000,
    legs: [{ source: "REFERRAL_CREDIT", amountPaise: 118_000 }],
    earnings,
    organizationEarnings: [],
  };
}

/** ₹800 consultant share, ₹300 already clawed back by an earlier reversal. */
function partlyReversedEarning(): Earn {
  return {
    id: "ce-1",
    consultantProfileId: "cp-1",
    consultantSharePaise: 80_000,
    refundedShareAmount: 30_000,
    status: "READY",
    payoutId: "po-1",
  };
}

/**
 * A `consultantEarnings` delegate whose `updateMany` really evaluates the
 * WHERE — a mock that ignored the predicates would pass regardless of the code
 * under test. `refuseAlways` models a row a concurrent writer keeps outrunning.
 */
function earningsDelegate(rows: Earn[], refuseAlways = false) {
  const updateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: {
        id: string;
        status?: { in: string[] };
        refundedShareAmount?: number;
      };
      data: Partial<Earn>;
    }) => {
      if (refuseAlways) return { count: 0 };
      const r = rows.find((e) => e.id === where.id);
      if (!r) return { count: 0 };
      if (where.status?.in && !where.status.in.includes(r.status))
        return { count: 0 };
      if (
        where.refundedShareAmount !== undefined &&
        where.refundedShareAmount !== r.refundedShareAmount
      ) {
        return { count: 0 };
      }
      Object.assign(r, data);
      return { count: 1 };
    },
  );
  const findUnique = jest.fn(async ({ where }: { where: { id: string } }) => {
    const r = rows.find((e) => e.id === where.id);
    return r
      ? { status: r.status, refundedShareAmount: r.refundedShareAmount }
      : null;
  });
  return { updateMany, findUnique };
}

function sum(
  postings: Array<{ direction: string; amountPaise: number }>,
  d: string,
) {
  return postings
    .filter((p) => p.direction === d)
    .reduce((s, p) => s + p.amountPaise, 0);
}

type PostingArg = {
  account: { kind: string };
  direction: string;
  amountPaise: number;
};

function lastPosting(): PostingArg[] {
  const calls = mockPostLedgerTxn.mock.calls;
  return calls[calls.length - 1]?.[1]?.postings ?? [];
}

function postingFor(kind: string) {
  return lastPosting().find(
    (p) => p.account.kind === kind && p.direction === "DEBIT",
  );
}

/** The real `postLedgerTxn` rejects any posting that is not positive paise. */
function expectNoZeroAmountPosting() {
  for (const call of mockPostLedgerTxn.mock.calls) {
    for (const p of call[1].postings) {
      expect(Number.isInteger(p.amountPaise)).toBe(true);
      expect(p.amountPaise).toBeGreaterThan(0);
    }
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  tx.refund.findFirst.mockResolvedValue(null);
  tx.refund.create.mockResolvedValue({ id: "refund-row-1" });
  mockReverseCredits.mockResolvedValue(118_000);
  mockReverseUtilization.mockResolvedValue(undefined);
  mockPaymentFindUnique
    .mockResolvedValueOnce({ paymentIntent: "free_1730000000_abc" })
    .mockResolvedValueOnce({
      id: PAYMENT_ID,
      currency: "INR",
      paymentStatus: "SUCCEEDED",
      paymentGateway: "RAZORPAY",
    });
});

describe("reversal posting — the APPLIED amount, never the request", () => {
  it("caps the journal and the TDS filing at what the CAS actually applied", async () => {
    const rows = [partlyReversedEarning()];
    const delegate = earningsDelegate(rows);
    tx.consultantEarnings.updateMany = delegate.updateMany;
    tx.consultantEarnings.findUnique = delegate.findUnique;
    tx.payment.findUniqueOrThrow.mockResolvedValue(settlement(rows));

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
    });

    // The request is the whole ₹800 share, but only ₹500 was still reversible:
    // 30,000 already clawed back. The column advanced by the APPLIED figure...
    expect(delegate.updateMany).toHaveBeenCalledTimes(1);
    expect(rows[0].refundedShareAmount).toBe(80_000);
    expect(rows[0].status).toBe("REFUNDED");

    // ...and the TDS reversal is filed for that same APPLIED figure. 80,000 here
    // would net withholding back out for paise the earning never gave up.
    expect(mockRecordTdsReversal).toHaveBeenCalledTimes(1);
    expect(mockRecordTdsReversal).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        earningsId: "ce-1",
        payoutId: "po-1",
        refundAmountPaise: 50_000,
        paymentAmountPaise: 80_000,
      }),
    );

    // The payable is debited by the applied figure too — this is the posting
    // reconcile-ledgers reads against ConsultantEarnings.
    expect(postingFor("CONSULTANT_PAYABLE")).toMatchObject({
      direction: "DEBIT",
      amountPaise: 50_000,
    });
    // Still balanced: funding 118,000 − applied 50,000 − GST 18,000 leaves the
    // platform its fee slice, so no leg is lost and nothing is over-debited.
    expect(sum(lastPosting(), "DEBIT")).toBe(sum(lastPosting(), "CREDIT"));
    expect(postingFor("PLATFORM_FEE")).toMatchObject({ amountPaise: 50_000 });
    expectNoZeroAmountPosting();
  });

  it("posts nothing at all when the CAS is refused twice", async () => {
    const rows = [partlyReversedEarning()];
    // The row keeps showing room, but the conditional write never matches.
    const delegate = earningsDelegate(rows, true);
    tx.consultantEarnings.updateMany = delegate.updateMany;
    tx.consultantEarnings.findUnique = delegate.findUnique;
    tx.payment.findUniqueOrThrow.mockResolvedValue(settlement(rows));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
    });

    // Both attempts ran, neither won — a reported no-op, never a claimed write.
    expect(delegate.updateMany).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("refused twice"));
    // Nothing was clawed back, so nothing may be claimed to have been: no TDS
    // netting and no payable debit (a pre-fix cascade filed both anyway).
    expect(mockRecordTdsReversal).not.toHaveBeenCalled();
    expect(postingFor("CONSULTANT_PAYABLE")).toBeUndefined();
    expect(rows[0].refundedShareAmount).toBe(30_000);
    expect(rows[0].status).toBe("READY");
    // The funding return is still journalled — the credits really came back —
    // so the txn balances with the whole amount as the fee residual.
    expect(sum(lastPosting(), "DEBIT")).toBe(sum(lastPosting(), "CREDIT"));
    expect(postingFor("PLATFORM_FEE")).toMatchObject({ amountPaise: 100_000 });
    expectNoZeroAmountPosting();
    warn.mockRestore();
  });

  it("posts nothing when the cap leaves zero paise — and never a 0-paise posting", async () => {
    const rows: Earn[] = [
      {
        ...partlyReversedEarning(),
        refundedShareAmount: 80_000,
        status: "REFUNDED",
      },
    ];
    const delegate = earningsDelegate(rows);
    tx.consultantEarnings.updateMany = delegate.updateMany;
    tx.consultantEarnings.findUnique = delegate.findUnique;
    tx.payment.findUniqueOrThrow.mockResolvedValue(settlement(rows));

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
    });

    // Already at its share: the helper short-circuits on the cap, so it never
    // issues the conditional write at all.
    expect(delegate.updateMany).not.toHaveBeenCalled();
    expect(mockRecordTdsReversal).not.toHaveBeenCalled();
    expect(postingFor("CONSULTANT_PAYABLE")).toBeUndefined();
    // A zero-amount `postLedgerTxn` would THROW ("each posting must be a
    // positive integer paise"), so "post nothing" has to mean an absent posting.
    expectNoZeroAmountPosting();
  });

  it("still posts the full request when nothing caps it — the normal path is unchanged", async () => {
    const rows: Earn[] = [
      { ...partlyReversedEarning(), refundedShareAmount: 0 },
    ];
    const delegate = earningsDelegate(rows);
    tx.consultantEarnings.updateMany = delegate.updateMany;
    tx.consultantEarnings.findUnique = delegate.findUnique;
    tx.payment.findUniqueOrThrow.mockResolvedValue(settlement(rows));

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
    });

    // Applied == request, so the figures the pre-fix code used were correct
    // here. This guards against the fix silently shrinking a normal reversal.
    expect(rows[0].refundedShareAmount).toBe(80_000);
    expect(postingFor("CONSULTANT_PAYABLE")).toMatchObject({
      amountPaise: 80_000,
    });
    expect(mockRecordTdsReversal).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ refundAmountPaise: 80_000 }),
    );
    expect(sum(lastPosting(), "DEBIT")).toBe(sum(lastPosting(), "CREDIT"));
    expectNoZeroAmountPosting();
  });
});
