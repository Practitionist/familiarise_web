/**
 * @jest-environment node
 */

/**
 * PM-12 / PM-11 — Razorpay core refund + order-receipt correctness.
 *
 * PM-12: createRazorpayRefund / listRazorpayRefunds must target the CAPTURED
 *   payment on an order, not items[0] (which can be an earlier failed attempt).
 * PM-11: createRazorpayOrder receipts must not collide within the same ms —
 *   the uuid suffix keeps them unique.
 *
 * We mock the `razorpay` SDK constructor so the module-load client is a stub
 * whose orders/payments methods we drive per-test.
 *
 * Refund CREATION no longer goes through the SDK — it is a raw POST so the
 * `X-Refund-Idempotency` header can actually be sent (the SDK drops unknown
 * headers). So the PM-12 target assertion now reads the request URL. The
 * order/payment LOOKUP still uses the SDK.
 */

// The client is built at module load from these env vars — set BEFORE the
// razorpay import is resolved.
process.env.RAZORPAY_KEY_ID = "rzp_test_key";
process.env.RAZORPAY_SECRET = "rzp_test_secret";

// Mocks live on a holder object so the hoisted jest.mock factory can reach them
// lazily (referencing top-level `const`s directly throws "before init").
const rzp = {
  ordersFetchPayments: jest.fn(),
  ordersFetch: jest.fn(),
  ordersCreate: jest.fn(),
  paymentsRefund: jest.fn(),
  paymentsFetchMultipleRefund: jest.fn(),
  refundsFetch: jest.fn(),
};

jest.mock("razorpay", () => {
  return jest.fn().mockImplementation(() => ({
    orders: {
      fetchPayments: (...a: unknown[]) => rzp.ordersFetchPayments(...a),
      fetch: (...a: unknown[]) => rzp.ordersFetch(...a),
      create: (...a: unknown[]) => rzp.ordersCreate(...a),
    },
    payments: {
      refund: (...a: unknown[]) => rzp.paymentsRefund(...a),
      fetchMultipleRefund: (...a: unknown[]) =>
        rzp.paymentsFetchMultipleRefund(...a),
    },
    refunds: { fetch: (...a: unknown[]) => rzp.refundsFetch(...a) },
  }));
});
jest.mock("../../lib/observability/report", () => ({
  ...jest.requireActual("../../lib/observability/report"),
  reportSentryError: jest.fn(),
}));

import { PaymentGateway } from "@prisma/client";
import { reportSentryError } from "@/lib/observability/report";
import {
  createRazorpayRefund,
  getRazorpayRefund,
  listRazorpayRefunds,
  createRazorpayOrder,
  fetchRazorpayOrder,
  readRazorpayOrderHolding,
} from "@/lib/payments/core/razorpay";

const ordersFetchPayments = rzp.ordersFetchPayments;
const ordersFetch = rzp.ordersFetch;
const ordersCreate = rzp.ordersCreate;
const paymentsFetchMultipleRefund = rzp.paymentsFetchMultipleRefund;

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

/** Queue one successful create-refund HTTP response. */
function mockRefundResponse(body: Record<string, unknown>) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

/** The payment id the refund was actually POSTed against. */
function refundedPaymentId(call = 0): string {
  const url = fetchMock.mock.calls[call][0] as string;
  return url.match(/\/payments\/([^/]+)\/refund$/)?.[1] ?? "";
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("order holding capture evidence", () => {
  it.each([
    [0, "INR"],
    [-100, "INR"],
    [1.5, "INR"],
    [Number.MAX_SAFE_INTEGER + 1, "INR"],
    [Number.NaN, "INR"],
    [100, "USD"],
  ])("rejects a captured amount of %s %s", async (amount, currency) => {
    ordersFetchPayments.mockResolvedValue({
      count: 1,
      items: [{ id: "pay_invalid", status: "captured", amount, currency }],
    });

    await expect(readRazorpayOrderHolding("order_invalid")).rejects.toThrow(
      /Order order_invalid captured/,
    );
  });

  it("returns a positive whole-INR capture after a failed payment attempt", async () => {
    ordersFetchPayments.mockResolvedValue({
      count: 2,
      items: [
        { id: "pay_failed", status: "failed", amount: 0, currency: "INR" },
        { id: "pay_valid", status: "captured", amount: 100, currency: "INR" },
      ],
    });

    await expect(readRazorpayOrderHolding("order_valid")).resolves.toEqual({
      kind: "captured",
      paymentId: "pay_valid",
      amountPaise: 100,
    });
  });
});

describe("PM-12 — createRazorpayRefund targets the captured payment", () => {
  it("refunds items[1] (captured) when items[0] is a failed attempt", async () => {
    ordersFetchPayments.mockResolvedValue({
      count: 2,
      items: [
        { id: "pay_failed", status: "failed" },
        { id: "pay_captured", status: "captured" },
      ],
    });
    mockRefundResponse({
      id: "rfnd_1",
      amount: 5000,
      currency: "inr",
      status: "processed",
      notes: {},
    });

    await createRazorpayRefund({
      idempotencyKey: "clx3k2j9a0000abcd1234efgh",
      paymentIntentId: "order_1",
      amount: 5000,
      reason: "requested_by_customer",
    });

    // The refund must be created on the CAPTURED payment, never the failed one.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refundedPaymentId()).toBe("pay_captured");
  });

  it("refuses NOT_CAPTURED when no payment is captured instead of refunding items[0] (#1584 P1-GW01b)", async () => {
    ordersFetchPayments.mockResolvedValue({
      count: 2,
      items: [
        { id: "pay_failed", status: "failed" },
        { id: "pay_only", status: "authorized" },
      ],
    });

    await expect(
      createRazorpayRefund({
        paymentIntentId: "order_2",
        amount: 1000,
        idempotencyKey: "clx3k2j9a0000abcd1234efgh",
      }),
    ).rejects.toMatchObject({ code: "NOT_CAPTURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("PM-12 — listRazorpayRefunds resolves the captured payment id", () => {
  it("lists refunds for items[1] (captured), not items[0] (failed)", async () => {
    ordersFetchPayments.mockResolvedValue({
      count: 2,
      items: [
        { id: "pay_failed", status: "failed" },
        { id: "pay_captured", status: "captured" },
      ],
    });
    paymentsFetchMultipleRefund.mockResolvedValue({ items: [] });

    await listRazorpayRefunds("order_3");

    expect(paymentsFetchMultipleRefund).toHaveBeenCalledTimes(1);
    expect(paymentsFetchMultipleRefund.mock.calls[0][0]).toBe("pay_captured");
  });
});

describe("getRazorpayRefund leaves an id the gateway does not know to the reconciler's one report", () => {
  it.each([
    ["a 404", { statusCode: 404, error: { description: "not found" } }, false],
    [
      "a 400 naming the id",
      {
        statusCode: 400,
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "The id provided does not exist",
          reason: "input_validation_failed",
        },
      },
      false,
    ],
    ["a 502", { statusCode: 502, error: { code: "GATEWAY_ERROR" } }, true],
  ])("%s", async (_label, gatewayError, reported) => {
    jest.mocked(reportSentryError).mockClear();
    rzp.refundsFetch.mockRejectedValue(gatewayError);

    await expect(getRazorpayRefund("rfnd_1")).rejects.toBeDefined();

    expect(jest.mocked(reportSentryError).mock.calls.length > 0).toBe(reported);
  });
});

describe("PM-11 — createRazorpayOrder receipts are unique within the same ms", () => {
  it("two orders created back-to-back get distinct receipts", async () => {
    ordersCreate.mockImplementation(async (args: { receipt: string }) => ({
      id: `order_${args.receipt}`,
      amount: 1000,
      currency: "INR",
      status: "created",
    }));

    const params = {
      amount: 1000,
      currency: "INR",
      metadata: { appointmentId: "appt_1", appointmentType: "ONE_ON_ONE" },
      paymentGateway: PaymentGateway.RAZORPAY,
    };
    await createRazorpayOrder(params);
    await createRazorpayOrder(params);

    const r1 = ordersCreate.mock.calls[0][0].receipt as string;
    const r2 = ordersCreate.mock.calls[1][0].receipt as string;

    expect(r1).not.toBe(r2);
    // Shape: receipt_<ms>_<8-char uuid slice>
    expect(r1).toMatch(/^receipt_\d+_[0-9a-f]{8}$/);
  });
});

describe("caller-bounded Razorpay SDK reads and creates", () => {
  afterEach(() => jest.useRealTimers());

  it("honours the caller timeout for order fetch and payment holding reads", async () => {
    jest.useFakeTimers();
    ordersFetch.mockReturnValue(new Promise(() => undefined));
    ordersFetchPayments.mockReturnValue(new Promise(() => undefined));

    const orderRead = fetchRazorpayOrder("order_slow", 25).catch(
      (error: unknown) => error,
    );
    const holdingRead = readRazorpayOrderHolding("order_slow", 25).catch(
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(25);

    for (const failure of await Promise.all([orderRead, holdingRead])) {
      expect(failure).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/timed out after 25ms/),
        }),
      );
    }
  });

  it("honours the caller timeout for order creation", async () => {
    jest.useFakeTimers();
    ordersCreate.mockReturnValue(new Promise(() => undefined));
    const request = createRazorpayOrder(
      {
        amount: 1000,
        currency: "INR",
        metadata: { appointmentId: "appt_1", appointmentType: "ONE_ON_ONE" },
        paymentGateway: PaymentGateway.RAZORPAY,
      },
      25,
    ).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(25);

    expect(await request).toMatchObject({ code: "UNKNOWN_ERROR" });
  });
});
