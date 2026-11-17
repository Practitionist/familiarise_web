/**
 * @jest-environment node
 */

/**
 * POST /api/admin/refunds is an ops door: it needs an Idempotency-Key header
 * (the refund's dedupe key) and a typed reason, and every refund failure
 * answers with its typed code rather than an empty 500.
 */

const refundPayment = jest.fn();

// The error classes live in the factory so the route and refusalResponse
// compare identical constructors without booting the real money graph.
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn().mockResolvedValue(null),
  moneyOpsLimiter: { limit: jest.fn() },
}));
jest.mock("../../lib/payments/operations/refund", () => {
  class RefundValidationError extends Error {
    constructor(
      message: string,
      public code: string,
      public detail?: Record<string, unknown>,
    ) {
      super(message);
      this.name = "RefundValidationError";
    }
  }
  class RefundGatewayError extends Error {
    constructor(
      message: string,
      public code: string,
    ) {
      super(message);
      this.name = "RefundGatewayError";
    }
  }
  return {
    refundPayment: (...args: unknown[]) => refundPayment(...args),
    RefundValidationError,
    RefundGatewayError,
  };
});
jest.mock("../../lib/backoffice/refund-doors", () => ({
  refundInFlightOr: async (err: unknown) => {
    throw err;
  },
  refundablePaymentPaise: async () => 0,
  refundableEventPaise: async () => 0,
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...args: unknown[]) => refundPayment(...args),
}));

const refundWholeEventPayments = jest.fn();
jest.mock("../../lib/payments/operations/event-refunds", () => ({
  classSeriesLedgers: async () => new Map(),
  refundWholeEventPayments: (...args: unknown[]) =>
    refundWholeEventPayments(...args),
}));

jest.mock("../../lib/auth-helpers", () => {
  const auth = async () => ({
    session: {
      user: { id: "admin_1", role: "ADMIN" },
      session: { createdAt: new Date() },
    },
  });
  return { requireBackofficeSurface: auth };
});

const reportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => reportSentryError(...args),
  reportSentryMessage: jest.fn(),
}));

const opsLog = jest.fn(async (_a: unknown) => ({ id: "ops_1" }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { opsActionLog: { create: (a: unknown) => opsLog(a) } },
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/admin/refunds/route";

const { RefundValidationError, RefundGatewayError } = jest.requireMock(
  "../../lib/payments/operations/refund",
) as {
  RefundValidationError: new (
    m: string,
    c: string,
    detail?: Record<string, unknown>,
  ) => Error;
  RefundGatewayError: new (m: string, c: string) => Error;
};

const KEY = "admin-refund-key-0001";
const ROUTE = { params: Promise.resolve({}) };

function refundRequest(body: unknown, key: string | null = KEY) {
  return new NextRequest("https://x.test/api/admin/refunds", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

const SINGLE = { paymentId: "pay_row_1", reason: "customer asked" };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("the door's own guards", () => {
  it("refuses a request without an Idempotency-Key before any refund", async () => {
    const res = await POST(refundRequest(SINGLE, null), ROUTE);

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(refundPayment).not.toHaveBeenCalled();
  });

  it("derives the refund's dedupe key from the header", async () => {
    refundPayment.mockResolvedValue({ refundId: "rfnd_1" });

    await POST(refundRequest(SINGLE), ROUTE);

    expect(refundPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: `admin-refund:admin_1:pay_row_1:${KEY}`,
      }),
    );
    expect(opsLog).toHaveBeenCalledTimes(1);
  });

  it("leaves the seat decision to the rail, with or without an amount", async () => {
    refundPayment.mockResolvedValue({ refundId: "rfnd_1" });

    await POST(refundRequest({ ...SINGLE, amountPaise: 10_000 }), ROUTE);
    await POST(
      refundRequest(
        { ...SINGLE, paymentId: "pay_row_2" },
        "admin-refund-key-0002",
      ),
      ROUTE,
    );

    for (const call of [1, 2]) {
      expect(refundPayment).toHaveBeenNthCalledWith(
        call,
        expect.objectContaining({ keepSeatIfPartial: true }),
      );
      expect(refundPayment.mock.calls[call - 1][0]).not.toHaveProperty(
        "keepSeat",
      );
    }
  });

  it("a replay answers the first refund; the same key on another payment does not collide", async () => {
    refundPayment.mockResolvedValue({ refundId: "rfnd_1" });

    const first = await POST(refundRequest(SINGLE), ROUTE);
    const replay = await POST(refundRequest(SINGLE), ROUTE);
    await POST(refundRequest({ ...SINGLE, paymentId: "pay_row_2" }), ROUTE);

    expect((await first.json()).result.refundId).toBe("rfnd_1");
    expect((await replay.json()).result.refundId).toBe("rfnd_1");
    const keys = refundPayment.mock.calls.map(
      ([input]) => (input as { dedupeKey: string }).dedupeKey,
    );
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("rejects a reason shorter than five characters", async () => {
    const res = await POST(
      refundRequest({ paymentId: "pay_row_1", reason: "ok" }),
      ROUTE,
    );

    expect(res.status).toBe(400);
    expect(refundPayment).not.toHaveBeenCalled();
  });

  it("rejects a payload naming more than one target", async () => {
    const res = await POST(
      refundRequest({ paymentId: "p1", classId: "c1", reason: "both of them" }),
      ROUTE,
    );

    expect(res.status).toBe(400);
    expect(refundPayment).not.toHaveBeenCalled();
  });
});

describe("a thrown refund answers with its typed code", () => {
  it("maps RefundValidationError to 409 with its code and copy", async () => {
    refundPayment.mockRejectedValue(
      new RefundValidationError(
        "Payment pay_row_1 has an open dispute (UNDER_REVIEW); resolve it before refunding",
        "REFUND_BLOCKED_BY_DISPUTE",
      ),
    );

    const res = await POST(refundRequest(SINGLE), ROUTE);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("REFUND_BLOCKED_BY_DISPUTE");
    expect(body.error).toContain("open dispute");
  });

  it("keeps ids out of the copy and answers them as detail", async () => {
    refundPayment.mockRejectedValue(
      new RefundValidationError(
        "This payment was not made with credits. Refund an amount instead.",
        "NOT_CREDIT_FUNDED",
        { paymentId: "pay_row_1" },
      ),
    );

    const res = await POST(refundRequest(SINGLE), ROUTE);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: "NOT_CREDIT_FUNDED",
      error:
        "This payment was not made with credits. Refund an amount instead.",
      paymentId: "pay_row_1",
    });
  });

  it("maps RefundGatewayError to 502", async () => {
    refundPayment.mockRejectedValue(
      new RefundGatewayError("Razorpay refund failed", "GATEWAY_REFUND_FAILED"),
    );

    const res = await POST(refundRequest(SINGLE), ROUTE);

    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("GATEWAY_REFUND_FAILED");
  });

  it("answers an unexpected error with a JSON body, and reports it", async () => {
    refundPayment.mockRejectedValue(new Error("connection terminated"));

    const res = await POST(refundRequest(SINGLE), ROUTE);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text).code).toBe("FAILED");
    expect(reportSentryError).toHaveBeenCalledTimes(1);
  });
});

describe("the success paths", () => {
  it("returns the single-payment result", async () => {
    refundPayment.mockResolvedValue({
      refundId: "rfnd_1",
      amountPaise: 250000,
    });

    const res = await POST(refundRequest(SINGLE), ROUTE);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kind: "payment",
      result: { refundId: "rfnd_1", amountPaise: 250000 },
    });
  });

  it("answers 200 with alreadyRefunded when the event was already refunded", async () => {
    refundWholeEventPayments.mockResolvedValue({
      refundsIssued: 0,
      refundedPaise: 0,
      childRefundIds: [],
      failures: [],
      skippedAlreadyRefunded: 2,
      alreadyRefunded: true,
    });

    const res = await POST(
      refundRequest({ classId: "class_1", reason: "cancelled again" }),
      ROUTE,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kind: "class",
      alreadyRefunded: true,
      refunded: 0,
    });
  });
});

describe("a whole-event refund a held refund marker refuses", () => {
  it("answers 409 with the operator copy naming the seat payment and the next step", async () => {
    const { Refusal } = jest.requireActual<
      typeof import("@/lib/errors/refusal")
    >("@/lib/errors/refusal");
    refundWholeEventPayments.mockRejectedValue(
      new Refusal({
        code: "REFUND_NEEDS_SUPPORT",
        httpStatus: 409,
        userMessage: "host copy",
        context: {
          paymentId: "pay_seat_1",
          heldKey: "occ:occ-1:pay:pay_seat_1",
          subject: "class",
        },
      }),
    );

    const res = await POST(
      refundRequest({ classId: "cls_1", reason: "class cancelled" }),
      ROUTE,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "REFUND_NEEDS_SUPPORT",
      error:
        "Seat payment pay_seat_1 has a refund still owed from another action (occ:occ-1:pay:pay_seat_1); settle it from Refunds → Needs human, then run this again.",
    });
  });
});
