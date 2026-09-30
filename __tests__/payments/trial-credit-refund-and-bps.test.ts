/**
 * @jest-environment node
 */

/**
 * Trial refund: the credits rail is quotable, and the percentage is scaled to
 * integer basis points.
 *
 * Two production money bugs, pinned on the same module because the fix for the
 * second sits in the arithmetic the first had to be read alongside.
 *
 *  1. `quoteTrialRefund` resolved its payment with `amount: { gt: 0 }`, so a
 *     credit-funded trial (`free_` intent, `Payment.amount === 0`) was
 *     unquotable. The cancel dialog rendered `{ paid: false }` — "nothing was
 *     paid for this" — and `refundCancelledTrial` returned null without ever
 *     reaching the credits rail. The referral credits the buyer spent were
 *     consumed and never restored: money silently lost, on the one population
 *     that had no card to charge.
 *
 *  2. The same quote computed `Math.floor(grossPaise * refundPct / 100)` in
 *     float. A policy rung may carry two decimals, so the product carries
 *     binary-representation error into a money amount before the floor runs.
 *     Every sibling path scales to integer basis points in BigInt and divides
 *     once; this was the only float left in the refund arithmetic.
 *
 * The `refundBookingPayment` mock enforces the real front door's rule — a
 * CREDITS-rail payment refuses any `amountPaise` with INVALID_AMOUNT — so
 * passing the quote's ₹0 fails the test rather than silently restoring nothing.
 */

const mockPaymentFindFirst = jest.fn();
const mockAppointmentFindUnique = jest.fn();
const mockRefundBookingPayment = jest.fn();
const mockTermsFromPolicyRow = jest.fn();
const mockCaptureException = jest.fn();

/** The front door's own error, so the refusal is recognisable in a failure. */
class MockRefundValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * `refundBookingPayment`'s three rails, reduced to what these tests read: the
 * credits arm refuses an amount and mints a ₹0 row, everything else pays the
 * amount. `paymentIntent` arrives on the call the way the front door reads it
 * off the row, so the rail assertion is about the payment and not the caller.
 */
function settleOnRail(input: {
  paymentIntent: string;
  amountPaise?: number;
}): Promise<{
  refundId: string;
  amountRefundedPaise: number;
  rail: "CREDITS" | "GATEWAY" | "INTERNAL";
}> {
  if (input.paymentIntent.startsWith("free_")) {
    if (input.amountPaise !== undefined) {
      return Promise.reject(
        new MockRefundValidationError(
          "credit-funded; the credits rail accepts no amount",
          "INVALID_AMOUNT",
        ),
      );
    }
    return Promise.resolve({
      refundId: "credits_rf-1",
      amountRefundedPaise: 0,
      rail: "CREDITS",
    });
  }
  return Promise.resolve({
    refundId: "rf-1",
    amountRefundedPaise: input.amountPaise ?? 0,
    rail: input.paymentIntent.startsWith("org_") ? "INTERNAL" : "GATEWAY",
  });
}

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (fn: (tx: unknown) => unknown) => fn({}),
    payment: {
      findFirst: (...a: unknown[]) => mockPaymentFindFirst(...a),
    },
    appointment: {
      findUnique: (...a: unknown[]) => mockAppointmentFindUnique(...a),
    },
  },
}));

jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (input: Record<string, unknown>) =>
    mockRefundBookingPayment(input),
  // The real prefix → rail mapping, so the quote's own predicate is exercised
  // rather than a hardcoded "GATEWAY".
  fundingRailForIntent: (intent: string | null | undefined) =>
    !intent
      ? "GATEWAY"
      : intent.startsWith("free_")
        ? "CREDITS"
        : intent.startsWith("org_")
          ? "INTERNAL"
          : "GATEWAY",
}));

/** A ladder the quote's own `computeRefundPct` reads; a rung may be 2dp. */
jest.mock("../../lib/payments/operations/cancellation-policy-store", () => ({
  POLICY_TERMS_INCLUDE: { tiers: true },
  termsFromPolicyRow: (...a: unknown[]) => mockTermsFromPolicyRow(...a),
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
}));

import {
  quoteTrialRefund,
  refundCancelledTrial,
} from "../../lib/trials/cancellation";

const APPOINTMENT_ID = "appt-1";
const PAYMENT_ID = "pay-credits";
const TRIAL_ID = "trial-1";
const USER_ID = "user-1";

/** ₹1,000 of referral credit bought this trial. `Payment.amount` is 0. */
const creditFundedTrial = {
  id: PAYMENT_ID,
  amount: BigInt(0),
  currency: "INR",
  paymentIntent: "free_abc123",
  refunds: [],
  disputes: [],
};

const terms = (tiers: { hoursBefore: number; refundPct: number }[]) => ({
  policyId: "pol-1",
  source: "PLATFORM" as const,
  version: 1,
  tiers,
  consultantInitiatedPct: 100,
});

function startingInHours(hours: number) {
  return {
    cancellationPolicy: null,
    occurrences: [{ startsAt: new Date(Date.now() + hours * 3_600_000) }],
  };
}

/**
 * The front door reads the intent off the payment ROW, but the callers pass only
 * an id — so the mock resolves the rail from the row the test just installed.
 */
let currentIntent = creditFundedTrial.paymentIntent;

function givenPayment(
  payment: { paymentIntent: string } & Record<string, unknown>,
) {
  currentIntent = payment.paymentIntent;
  mockPaymentFindFirst.mockResolvedValue(payment);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTermsFromPolicyRow.mockReturnValue(null);
  currentIntent = creditFundedTrial.paymentIntent;
  mockRefundBookingPayment.mockImplementation(
    (input: { paymentId: string; amountPaise?: number }) =>
      settleOnRail({ ...input, paymentIntent: currentIntent }),
  );
});

describe("quoteTrialRefund — the credits rail is quotable", () => {
  it("quotes a credit-funded trial instead of answering null", async () => {
    givenPayment(creditFundedTrial);
    mockAppointmentFindUnique.mockResolvedValue(startingInHours(72));

    const quote = await quoteTrialRefund({
      appointmentId: APPOINTMENT_ID,
      paymentId: PAYMENT_ID,
      isConsultantInitiated: false,
    });

    // The regression: `amount: { gt: 0 }` made this null, and the dialog read
    // "nothing was paid for this".
    expect(quote).not.toBeNull();
    expect(quote?.fundingRail).toBe("CREDITS");
    expect(quote?.grossPaise).toBe(0);
    // The credits rail restores all or nothing: above a 0% tier it restores in
    // full, which is why `refundPct` reads 100 next to a ₹0 amount.
    expect(quote?.creditRestoresInFull).toBe(true);
    expect(quote?.refundPct).toBe(100);
    expect(quote?.estimatedRefundPaise).toBe(0);
  });

  it("does not filter the payment query on a positive amount", async () => {
    givenPayment(creditFundedTrial);
    mockAppointmentFindUnique.mockResolvedValue(startingInHours(72));

    await quoteTrialRefund({
      appointmentId: APPOINTMENT_ID,
      paymentId: PAYMENT_ID,
      isConsultantInitiated: false,
    });

    expect(mockPaymentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ amount: expect.anything() }),
      }),
    );
  });

  it("a `free_` payment with a NON-zero amount is a mixed payment, not a credit restore", async () => {
    // Both halves of the predicate are load-bearing: this one settles on the
    // money arm, and the credits rail would refuse it with INVALID_AMOUNT.
    givenPayment({ ...creditFundedTrial, amount: BigInt(50_000) });
    mockAppointmentFindUnique.mockResolvedValue(startingInHours(72));

    const quote = await quoteTrialRefund({
      appointmentId: APPOINTMENT_ID,
      paymentId: PAYMENT_ID,
      isConsultantInitiated: false,
    });

    expect(quote?.creditRestoresInFull).toBe(false);
    expect(quote?.estimatedRefundPaise).toBe(50_000);
  });

  it("a 0% tier on a credit-funded trial restores nothing", async () => {
    mockTermsFromPolicyRow.mockReturnValue(
      terms([
        { hoursBefore: 24, refundPct: 0 },
        { hoursBefore: 0, refundPct: 0 },
      ]),
    );
    givenPayment(creditFundedTrial);
    // Inside the window: 1 hour out, so the 24h rung does not clear.
    mockAppointmentFindUnique.mockResolvedValue(startingInHours(1));

    const quote = await quoteTrialRefund({
      appointmentId: APPOINTMENT_ID,
      paymentId: PAYMENT_ID,
      isConsultantInitiated: false,
    });

    // A late cancel bites a credit buyer exactly as it bites a card buyer.
    expect(quote?.creditRestoresInFull).toBe(false);
    expect(quote?.refundPct).toBe(0);
  });
});

describe("refundCancelledTrial — the credits actually come back", () => {
  it("restores the credits through the front door with no amount", async () => {
    givenPayment(creditFundedTrial);
    mockAppointmentFindUnique.mockResolvedValue(startingInHours(72));

    const result = await refundCancelledTrial({
      trialId: TRIAL_ID,
      appointmentId: APPOINTMENT_ID,
      paymentId: PAYMENT_ID,
      initiatedByUserId: USER_ID,
      isConsultantInitiated: false,
    });

    // The regression: `if (amountPaise <= 0) return …` fired on the ₹0 quote and
    // never called the front door, so the credits stayed consumed.
    expect(mockRefundBookingPayment).toHaveBeenCalledTimes(1);
    const call = mockRefundBookingPayment.mock.calls[0][0];
    // Omitting the amount IS the credits rail's documented call. Passing the
    // quote's ₹0 would be refused INVALID_AMOUNT and lose the restoration.
    expect(call).not.toHaveProperty("amountPaise");
    expect(call.paymentId).toBe(PAYMENT_ID);
    // A CREDITS-rail refund, not a GATEWAY one: nothing was ever charged.
    expect(result?.rail).toBe("CREDITS");
    // The Refund row is ₹0 by construction — the value that came back is the
    // restored credit, which is what `rail` tells the UI to say out loud.
    expect(result?.amountRefundedPaise).toBe(0);
    expect(result?.failed).toBeUndefined();
  });

  it("names the real tier in the audit reason, not the rounded-up 100", async () => {
    mockTermsFromPolicyRow.mockReturnValue(
      terms([
        { hoursBefore: 24, refundPct: 50 },
        { hoursBefore: 0, refundPct: 0 },
      ]),
    );
    givenPayment(creditFundedTrial);
    mockAppointmentFindUnique.mockResolvedValue(startingInHours(72));

    const result = await refundCancelledTrial({
      trialId: TRIAL_ID,
      appointmentId: APPOINTMENT_ID,
      paymentId: PAYMENT_ID,
      initiatedByUserId: USER_ID,
      isConsultantInitiated: false,
    });

    // The policy said 50%. The money trail must not claim a tier it did not set.
    expect(result?.refundPct).toBe(100);
    expect(mockRefundBookingPayment.mock.calls[0][0].reason).toContain("50%");
  });

  it("a 0% tier never reaches the credits rail", async () => {
    mockTermsFromPolicyRow.mockReturnValue(
      terms([
        { hoursBefore: 24, refundPct: 0 },
        { hoursBefore: 0, refundPct: 0 },
      ]),
    );
    givenPayment(creditFundedTrial);
    mockAppointmentFindUnique.mockResolvedValue(startingInHours(1));

    const result = await refundCancelledTrial({
      trialId: TRIAL_ID,
      appointmentId: APPOINTMENT_ID,
      paymentId: PAYMENT_ID,
      initiatedByUserId: USER_ID,
      isConsultantInitiated: false,
    });

    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    expect(result).toEqual({ refundPct: 0, amountRefundedPaise: 0, rail: null });
  });
});

describe("quoteTrialRefund — basis points, not floats (#1396)", () => {
  it("scales a two-decimal rung to integer paise with no representation error", async () => {
    // A policy rung may carry two decimals, and 99_999 * 12.5 is 1_249_987.5 —
    // a product the float path carried into a money amount before flooring.
    mockTermsFromPolicyRow.mockReturnValue(
      terms([
        { hoursBefore: 24, refundPct: 12.5 },
        { hoursBefore: 0, refundPct: 0 },
      ]),
    );
    givenPayment({ ...creditFundedTrial, amount: BigInt(99_999), paymentIntent: "pi_test" });
    mockAppointmentFindUnique.mockResolvedValue(startingInHours(72));

    const quote = await quoteTrialRefund({
      appointmentId: APPOINTMENT_ID,
      paymentId: PAYMENT_ID,
      isConsultantInitiated: false,
    });

    // 12.5% of 99_999 paise = 12_499.875, which floors to 12_499.
    expect(quote?.estimatedRefundPaise).toBe(12_499);
  });

  it("keeps the same rounding direction as every other rail", async () => {
    // BigInt division truncates toward zero and both operands are non-negative,
    // so it floors, exactly as the previous Math.floor did. A change here would
    // be a quote/charge disagreement.
    for (const pct of [100, 50, 33, 12.5, 0.07, 2]) {
      mockTermsFromPolicyRow.mockReturnValue(
        terms([
          { hoursBefore: 24, refundPct: pct },
          { hoursBefore: 0, refundPct: 0 },
        ]),
      );
      givenPayment({
        ...creditFundedTrial,
        amount: BigInt(123_457),
        paymentIntent: "pi_test",
      });
      mockAppointmentFindUnique.mockResolvedValue(startingInHours(72));

      const quote = await quoteTrialRefund({
        appointmentId: APPOINTMENT_ID,
        paymentId: PAYMENT_ID,
        isConsultantInitiated: false,
      });

      expect(quote?.estimatedRefundPaise).toBe(
        Math.floor((123_457 * pct) / 100),
      );
    }
  });

  it("a gateway quote still sends an amount, and reports the GATEWAY rail", async () => {
    mockTermsFromPolicyRow.mockReturnValue(
      terms([
        { hoursBefore: 24, refundPct: 50 },
        { hoursBefore: 0, refundPct: 0 },
      ]),
    );
    givenPayment({
      ...creditFundedTrial,
      amount: BigInt(100_000),
      paymentIntent: "pi_test",
    });
    // Inside the 50% rung's window, not merely inside the policy: the ladder
    // hands out the first tier whose notice the cancellation clears, and at one
    // hour that is the 0h rung. The quote would then be ₹0, `refundCancelledTrial`
    // would return before the front door, and the case would read as "the card
    // rail sends no amount" — pinning a half refund the policy never promised.
    mockAppointmentFindUnique.mockResolvedValue(startingInHours(72));

    const result = await refundCancelledTrial({
      trialId: TRIAL_ID,
      appointmentId: APPOINTMENT_ID,
      paymentId: PAYMENT_ID,
      initiatedByUserId: USER_ID,
      isConsultantInitiated: false,
    });

    expect(mockRefundBookingPayment.mock.calls[0][0].amountPaise).toBe(50_000);
    expect(result?.rail).toBe("GATEWAY");
  });
});
