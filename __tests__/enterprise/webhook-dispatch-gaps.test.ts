/**
 * @jest-environment node
 */

/**
 * Regression coverage for the webhook dispatch gaps found in the #789 audit.
 *
 * Each block asserts the CORRECT routing. Before the dispatch-switch fixes in
 * razorpay-dispatch.ts these assertions fail (the events fall through to the
 * `default` "unhandled" branch and the handler is never called); after the fix
 * they pass. The handlers themselves are mocked so we are testing routing only.
 */

import { processRazorpayWebhookEvent } from "../../app/api/webhooks/razorpay-dispatch";

const handleRazorpayPayoutWebhook = jest.fn().mockResolvedValue(undefined);
const handleDisputeUpdated = jest.fn().mockResolvedValue(undefined);
const markWebhookEventProcessed = jest.fn().mockResolvedValue(undefined);
const handlePaymentSuccess = jest.fn().mockResolvedValue(undefined);

jest.mock("../../app/api/webhooks/utils", () => ({
  __esModule: true,
  handlePaymentFailure: jest.fn(),
  handlePaymentSuccess: (...args: unknown[]) => handlePaymentSuccess(...args),
  handleOrgPaymentSuccess: jest.fn(),
  handleOrgPaymentFailure: jest.fn(),
  handleRefundCreated: jest.fn(),
  handleDisputeCreated: jest.fn(),
  handleDisputeUpdated: (...args: unknown[]) => handleDisputeUpdated(...args),
  markWebhookEventProcessed: (...args: unknown[]) =>
    markWebhookEventProcessed(...args),
  handleRazorpayPayoutWebhook: (...args: unknown[]) =>
    handleRazorpayPayoutWebhook(...args),
}));

jest.mock("../../lib/payments/webhooks/overage-handlers", () => ({
  __esModule: true,
  handleOverageMemberSuccess: jest.fn(),
  handleOverageMemberFailure: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

function payoutEnvelope(status: string) {
  return {
    event: `payout.${status}`,
    payload: { payout: { entity: { id: "pout_test_1", status } } },
  };
}

function disputeEnvelope(suffix: string, status: string) {
  return {
    event: `payment.dispute.${suffix}`,
    payload: { dispute: { entity: { id: "disp_test_1", status } } },
  };
}

describe("RazorpayX payout.failed routing", () => {
  it("routes payout.failed to the payout reconciler (not the default drop)", async () => {
    await processRazorpayWebhookEvent(
      payoutEnvelope("failed") as never,
      "payout.failed",
      "payout.failed:pout_test_1",
    );
    expect(handleRazorpayPayoutWebhook).toHaveBeenCalledWith(
      "payout.failed",
      expect.objectContaining({ id: "pout_test_1", status: "failed" }),
    );
  });
});

describe("dispute lifecycle event routing", () => {
  it("routes payment.dispute.under_review to handleDisputeUpdated", async () => {
    await processRazorpayWebhookEvent(
      disputeEnvelope("under_review", "under_review") as never,
      "payment.dispute.under_review",
      "payment.dispute.under_review:disp_test_1",
    );
    expect(handleDisputeUpdated).toHaveBeenCalledWith(
      "disp_test_1",
      "under_review",
      null,
    );
  });

  it("routes payment.dispute.action_required to handleDisputeUpdated", async () => {
    await processRazorpayWebhookEvent(
      disputeEnvelope("action_required", "action_required") as never,
      "payment.dispute.action_required",
      "payment.dispute.action_required:disp_test_1",
    );
    expect(handleDisputeUpdated).toHaveBeenCalledWith(
      "disp_test_1",
      "action_required",
      null,
    );
  });
});

describe("schema mismatch is terminal (FAMILIARISE_WEB-3W)", () => {
  it("stamps a payment.captured payload missing required fields with the permanent: prefix", async () => {
    // Before the fix the raw ZodError message was stored, so the sweeper
    // re-drove the row every tick for the whole 168-hour give-up window.
    await processRazorpayWebhookEvent(
      {
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_S4Priya00000001" } } },
      } as never,
      "payment.captured",
      "payment.captured:pay_S4Priya00000001",
    );
    expect(markWebhookEventProcessed).toHaveBeenCalledTimes(1);
    const [eventId, error] = markWebhookEventProcessed.mock.calls[0];
    expect(eventId).toBe("payment.captured:pay_S4Priya00000001");
    expect(error).toMatch(/^permanent: schema mismatch: payment\.captured/);
  });
});

describe("order.paid carries the payment entity (#1582 F-P0-01)", () => {
  it("forwards the pay_* id and the payment amount when Razorpay ships both entities", async () => {
    const paymentEntity = {
      id: "pay_OrderPaid000001",
      entity: "payment",
      amount: 118000,
      currency: "INR",
      status: "captured",
      order_id: "order_OrderPaid0001",
      invoice_id: null,
      international: false,
      method: "upi",
      amount_refunded: 0,
      refund_status: null,
      captured: true,
      description: null,
      card_id: null,
      bank: null,
      wallet: null,
      vpa: "buyer@upi",
      email: "buyer@example.com",
      contact: "+919999999999",
      notes: { type: "booking" },
      fee: null,
      tax: null,
      error_code: null,
      error_description: null,
      error_source: null,
      error_step: null,
      error_reason: null,
      created_at: 1_700_000_000,
    };
    const orderEntity = {
      id: "order_OrderPaid0001",
      entity: "order",
      amount: 118000,
      amount_paid: 118000,
      amount_due: 0,
      currency: "INR",
      receipt: null,
      offer_id: null,
      status: "paid",
      attempts: 1,
      notes: { type: "booking" },
      created_at: 1_700_000_000,
    };
    await processRazorpayWebhookEvent(
      {
        entity: "event",
        account_id: "acc_test",
        event: "order.paid",
        contains: ["payment", "order"],
        payload: {
          payment: { entity: paymentEntity },
          order: { entity: orderEntity },
        },
        created_at: 1_700_000_000,
      } as never,
      "order.paid",
      "order.paid:order_OrderPaid0001",
    );
    expect(handlePaymentSuccess).toHaveBeenCalledWith(
      "order_OrderPaid0001",
      { type: "booking" },
      118000,
      "pay_OrderPaid000001",
    );
  });
});
