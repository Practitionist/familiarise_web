/**
 * @jest-environment node
 */

/**
 * Rejecting a paid request has to give the money back (#1004).
 *
 * Direct checkout captures BEFORE the request row exists — `createConsultation`
 * / `createSubscription` land it `PENDING` with a `SUCCEEDED` payment already
 * attached. `REJECTED` is legally reachable from `PENDING`, so a consultant
 * declining a direct-checkout booking left the buyer paid-up with nothing, and
 * with no way out: `REJECTED` is not in `CANCELLABLE_FROM`, so the cancel route
 * 409s and the money simply stayed captured.
 *
 * Pinned here:
 *  - the refund is stamped owed in the reject commit and driven after it
 *  - a paid rejected request refunds at the consultant-initiated percentage
 *  - the whole booking's payment is found, not just one appointment's
 *  - an unpaid request mints no refund at all
 *  - the refund never throws — the rejection has already committed
 *  - ONLY the consultant can trigger it (see the security case below)
 */

const mockResolveContext = jest.fn();
const mockRefundBookingPayment = jest.fn();
const mockIsFreeCreditIntent = jest.fn();
const mockNotifyRefundProcessed = jest.fn();
const mockPaymentFindUnique = jest.fn();
const mockCaptureException = jest.fn();
const mockRecordSystemError = jest.fn();
const mockRecordSystemEvent = jest.fn();

jest.mock("../../lib/booking/cancellation-scope", () => ({
  resolveBookingRefundContext: (...a: unknown[]) => mockResolveContext(...a),
}));

jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => mockRefundBookingPayment(...a),
}));
jest.mock("../../lib/payments/funding-rail", () => ({
  isFreeCreditIntent: (...a: unknown[]) => mockIsFreeCreditIntent(...a),
}));

jest.mock("../../lib/novu", () => ({
  notifyRefundProcessed: (...a: unknown[]) => mockNotifyRefundProcessed(...a),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findUnique: (...a: unknown[]) => mockPaymentFindUnique(...a),
      updateMany: async () => ({ count: 1 }),
    },
  },
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  findDedupedRefund: async () => null,
  RefundGatewayError: class extends Error {},
  RefundValidationError: class extends Error {},
}));

jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
}));

jest.mock("../../lib/enterprise/system-events", () => {
  return {
    recordSystemError: (...a: unknown[]) => mockRecordSystemError(...a),
    recordSystemErrorSafe: (...a: unknown[]) => mockRecordSystemError(...a),
    recordSystemEvent: (...a: unknown[]) => mockRecordSystemEvent(...a),
  };
});

import { PLATFORM_DEFAULT_TERMS } from "@/lib/payments/operations/cancellation-policy";
import {
  refundRejectedRequest,
  stampRejectionRefundOwed,
} from "../../lib/booking/rejection-refund";

const mockStamp = jest.fn(async () => ({ count: 1 }));
const mockTxFindUnique = jest.fn();
const tx = {
  payment: { updateMany: mockStamp, findUnique: mockTxFindUnique },
  systemEvent: { findFirst: async () => null },
  refund: { findFirst: async () => null },
  // No unpaid earnings yet: the hand top-up hold has nothing to freeze.
  consultantEarnings: { findMany: async () => [] },
  organizationEarnings: { findMany: async () => [] },
} as never;

/** The route's two halves: stamp in the reject commit, drive after it. */
async function rejectAndRefund(args: {
  kind: "consultation" | "subscription";
  requestId: string;
  initiatedByUserId: string;
  actor: "CONSULTANT" | "PLATFORM" | "CONSULTEE";
}) {
  const plan = await stampRejectionRefundOwed(tx, args);
  return refundRejectedRequest({ ...args, plan });
}

const PAID = {
  paidPayment: {
    id: "pay-1",
    amountPaise: 100_000,
    refundablePaise: 100_000,
    paymentIntent: "pay_ABC",
  },
  // #1499 — the context resolves terms, never a raw column; null tiers would be an
  // impossible shape, so PLATFORM_DEFAULT_TERMS is what an unpublished booking reads.
  policy: PLATFORM_DEFAULT_TERMS,
  hoursUntilNextSession: null,
  sessionsCompleted: 0,
  sessionsRemaining: 0,
  slotsTotal: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveContext.mockResolvedValue(PAID);
  mockIsFreeCreditIntent.mockReturnValue(false);
  mockRefundBookingPayment.mockResolvedValue({
    refundId: "r1",
    amountRefundedPaise: 100_000,
    rail: "GATEWAY",
  });
  mockPaymentFindUnique.mockResolvedValue({
    userId: "user-1",
    currency: "INR",
    organizationId: null,
  });
  mockNotifyRefundProcessed.mockResolvedValue(undefined);
  mockRecordSystemError.mockResolvedValue(undefined);
});

/**
 * The percentage here is 100 and ignores every notice tier, so whoever can
 * reach this function has a full refund on demand. `REJECTED` is legal from
 * PENDING and APPROVED_PENDING_PAYMENT, both PATCH routes authorize any
 * participant, and the transition guard checks only the from-state — so the
 * actor is the ONLY thing standing between a buyer and their own money back.
 */
describe("who is allowed to trigger a rejection refund", () => {
  it("refuses a consultee-initiated reject", async () => {
    const result = await rejectAndRefund({
      kind: "consultation",
      requestId: "cons-1",
      initiatedByUserId: "consultee-1",
      actor: "CONSULTEE",
    });

    expect(result).toBeNull();
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    // Reaching here at all means a route guard is missing, so it is durable.
    expect(mockRecordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({ category: "PAYMENT" }),
    );
  });

  it("allows a platform-initiated reject", async () => {
    const result = await rejectAndRefund({
      kind: "consultation",
      requestId: "cons-1",
      initiatedByUserId: "admin-1",
      actor: "PLATFORM",
    });

    expect(result?.amountRefundedPaise).toBe(100_000);
  });
});

describe("refundRejectedRequest", () => {
  it("refunds a rejected consultation in full", async () => {
    const result = await rejectAndRefund({
      kind: "consultation",
      requestId: "cons-1",
      initiatedByUserId: "consultant-1",
      actor: "CONSULTANT",
    });

    // Platform default consultantInitiatedPct — the buyer did nothing wrong.
    expect(result).toEqual({ refundPct: 100, amountRefundedPaise: 100_000 });
    expect(mockStamp).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          refundOwedKey: "rejection:cons-1:pay-1",
          refundOwedPaise: 100_000,
        }),
      }),
    );
    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay-1",
        amountPaise: 100_000,
        dedupeKey: "rejection:cons-1:pay-1",
      }),
    );
  });

  it("adds nothing to another door's owed refund, and says so", async () => {
    mockStamp.mockResolvedValueOnce({ count: 0 });
    const heldRow = {
      id: "pay-1",
      refundOwedKey: "cancel:appt-1:pay-1",
      refundOwedPaise: 40_000,
      amount: 100_000,
      refunds: [],
      disputes: [],
    };
    // The holding marker, then the balance the top-up is capped at.
    mockTxFindUnique
      .mockResolvedValueOnce(heldRow)
      .mockResolvedValueOnce(heldRow);
    const result = await rejectAndRefund({
      kind: "consultation",
      requestId: "cons-1",
      initiatedByUserId: "consultant-1",
      actor: "CONSULTANT",
    });
    expect(result).toMatchObject({
      amountRefundedPaise: 0,
      alreadyOwed: {
        heldKey: "cancel:appt-1:pay-1",
        note: "A refund of ₹400.00 was already owed on payment pay-1 for another reason (cancel:appt-1:pay-1), so this action added nothing to it. Refund any difference by hand.",
      },
    });
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    expect(mockRecordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "WARN",
        correlationId: "owed-already-held:pay-1:rejection:cons-1:pay-1",
        strict: true,
        // What the holding ₹400 leaves of the ₹1,000 balance.
        context: expect.objectContaining({ owedPaise: 60_000 }),
      }),
    );
  });

  it("looks the payment up by the whole booking, not one appointment", async () => {
    await rejectAndRefund({
      kind: "subscription",
      requestId: "sub-1",
      initiatedByUserId: "consultant-1",
      actor: "CONSULTANT",
    });

    expect(mockResolveContext).toHaveBeenCalledWith(
      { subscriptionId: "sub-1" },
      undefined,
      tx,
    );
  });

  it("mints nothing for a request that was never paid", async () => {
    mockResolveContext.mockResolvedValue({ ...PAID, paidPayment: null });

    const result = await rejectAndRefund({
      kind: "consultation",
      requestId: "cons-1",
      initiatedByUserId: "consultant-1",
      actor: "CONSULTANT",
    });

    expect(result).toBeNull();
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("ignores the clock — a rejection is never time-tiered", async () => {
    // The session is an hour out, where a consultee cancelling gets nothing.
    mockResolveContext.mockResolvedValue({
      ...PAID,
      hoursUntilNextSession: 1,
    });

    const result = await rejectAndRefund({
      kind: "consultation",
      requestId: "cons-1",
      initiatedByUserId: "consultant-1",
      actor: "CONSULTANT",
    });

    expect(result?.refundPct).toBe(100);
  });

  it("tells the buyer their money is coming back", async () => {
    await rejectAndRefund({
      kind: "consultation",
      requestId: "cons-1",
      initiatedByUserId: "consultant-1",
      actor: "CONSULTANT",
    });
    await Promise.resolve();

    expect(mockNotifyRefundProcessed).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ amount: 100_000, currency: "INR" }),
      // The expert declined the buyer's request: required for the payer.
      { required: { kind: "REQUEST_DECLINED", recipients: ["user-1"] } },
    );
  });

  it("clamps to what is still refundable", async () => {
    // 100% of the gross overshoots a payment that has already given some back;
    // the operation would reject the whole request and the buyer would get
    // nothing instead of the remainder.
    mockResolveContext.mockResolvedValue({
      ...PAID,
      paidPayment: {
        id: "pay-1",
        amountPaise: 100_000,
        refundablePaise: 30_000,
        paymentIntent: "pay_ABC",
      },
    });
    mockRefundBookingPayment.mockResolvedValue({
      refundId: "r1",
      amountRefundedPaise: 30_000,
      rail: "GATEWAY",
    });

    const result = await rejectAndRefund({
      kind: "consultation",
      requestId: "cons-1",
      initiatedByUserId: "consultant-1",
      actor: "CONSULTANT",
    });

    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 30_000 }),
    );
    expect(result?.amountRefundedPaise).toBe(30_000);
  });

  it("quotes the confirmed amount to the payer, not the requested one", async () => {
    mockRefundBookingPayment.mockResolvedValue({
      refundId: "r1",
      amountRefundedPaise: 90_000,
      rail: "GATEWAY",
    });

    await rejectAndRefund({
      kind: "consultation",
      requestId: "cons-1",
      initiatedByUserId: "consultant-1",
      actor: "CONSULTANT",
    });
    await Promise.resolve();

    // Telling the buyer a figure they never receive is worse than telling none.
    expect(mockNotifyRefundProcessed).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ amount: 90_000 }),
      { required: { kind: "REQUEST_DECLINED", recipients: ["user-1"] } },
    );
  });

  it("sends a credit-funded payment through the front door with no amount (#1161)", async () => {
    // amount 0 means the refundable clamp reads 0 and used to skip the refund
    // entirely — the buyer's credits stayed consumed. The credits rail takes
    // no partial amount, so it routes around the clamp.
    mockResolveContext.mockResolvedValue({
      ...PAID,
      paidPayment: {
        id: "pay-free-1",
        amountPaise: 0,
        refundablePaise: 0,
        paymentIntent: "free_1730000000_abc",
      },
    });
    mockIsFreeCreditIntent.mockReturnValue(true);
    mockRefundBookingPayment.mockResolvedValue({
      refundId: "r1",
      amountRefundedPaise: 0,
      rail: "CREDITS",
    });

    const result = await rejectAndRefund({
      kind: "consultation",
      requestId: "cons-1",
      initiatedByUserId: "consultant-1",
      actor: "CONSULTANT",
    });

    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-free-1" }),
    );
    expect(
      mockRefundBookingPayment.mock.calls[0][0].amountPaise,
    ).toBeUndefined();
    expect(result).toEqual({ refundPct: 100, amountRefundedPaise: 0 });
  });

  it("leaves the rejection standing when the refund fails", async () => {
    mockRefundBookingPayment.mockRejectedValue(new Error("gateway down"));

    // Must not throw — the request is already REJECTED by the time this runs.
    const result = await rejectAndRefund({
      kind: "consultation",
      requestId: "cons-1",
      initiatedByUserId: "consultant-1",
      actor: "CONSULTANT",
    });

    expect(result).toEqual({
      refundPct: 0,
      amountRefundedPaise: 0,
      failed: true,
    });
    // A silently swallowed refund failure is how money goes missing unnoticed.
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it("does not fail a settled refund when the notification breaks", async () => {
    mockNotifyRefundProcessed.mockRejectedValue(new Error("novu down"));

    const result = await rejectAndRefund({
      kind: "consultation",
      requestId: "cons-1",
      initiatedByUserId: "consultant-1",
      actor: "CONSULTANT",
    });

    expect(result?.amountRefundedPaise).toBe(100_000);
    expect(result?.failed).toBeUndefined();
  });
});

// #1780 R-3 — the rejection refund's amount is integer basis points in
// BigInt, the same arithmetic as cancellation-policy, never float paise.
it("computes the rejection amount in BigInt basis points", () => {
  const src = jest
    .requireActual<typeof import("fs")>("fs")
    .readFileSync(`${process.cwd()}/lib/booking/rejection-refund.ts`, "utf8");
  expect(src).toContain("BigInt(Math.round(refundPct * 100))");
  expect(src).not.toContain(
    "Math.floor((ctx.paidPayment.amountPaise * refundPct) / 100)",
  );
});
