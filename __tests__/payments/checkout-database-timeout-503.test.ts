/**
 * @jest-environment node
 */

// A database timeout before the booking commits leaves POST /api/checkout as a
// typed 503 through the real checkout core; one at the commit's COMMIT does not.

const $transaction = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (...a: unknown[]) => $transaction(...a),
    consultantProfile: { findUnique: jest.fn(async () => null) },
  },
}));
const PRICED = {
  amount: 100_000,
  originalAmount: 100_000,
  taxAmount: 0,
  currency: "INR",
  creditsApplied: 0,
  consulteeProfileId: "cp-1",
  gstRegime: "UNREGISTERED",
};
// The real price derivation unless a case resolves it, so its own transaction can expire.
const calculateAmountAndValidate = jest.fn();
jest.mock("../../lib/payments/checkout/pricing", () => ({
  calculateAmountAndValidate: (...a: unknown[]) =>
    calculateAmountAndValidate(...a),
}));
const revalidateInsideLock = jest.fn();
jest.mock("../../lib/payments/checkout/revalidate", () => ({
  revalidateInsideLock: (...a: unknown[]) => revalidateInsideLock(...a),
}));
jest.mock("../../lib/payments/checkout/locks", () => ({
  getPlanDataForLock: jest.fn(async () => ({})),
  acquireCheckoutLock: jest.fn(async () => ({ key: "k", token: "t" })),
  releaseCheckoutLock: jest.fn(),
  lockBuyerSeatAtoms: jest.fn(async () => null),
  lockExpertPlanSales: jest.fn(async () => null),
}));
jest.mock("../../utils/appointmentlock", () => ({
  ...jest.requireActual("../../utils/appointmentlock"),
  lockConsulteeBooking: jest.fn(async () => null),
  unlockConsulteeBooking: jest.fn(),
  extendLock: jest.fn(async () => true),
}));
jest.mock("../../lib/payments/checkout/order-reuse", () => ({
  openOrderTargetOf: () => null,
  findReusablePendingOrderPayment: jest.fn(),
  releaseSupersededHolds: jest.fn(),
}));
jest.mock("../../lib/payments/operations/cancellation-policy-store", () => ({
  ensurePlatformCancellationPolicy: jest.fn(),
  resolveCheckoutCancellationPolicyId: jest.fn(),
}));
const createPaymentIntent = jest.fn(async () => ({
  id: "order_1",
  client_secret: null,
}));
const cancelPaymentIntent = jest.fn();
jest.mock("../../lib/payments/index", () => ({
  createPaymentIntent: () => createPaymentIntent(),
  cancelPaymentIntent: (...a: unknown[]) => cancelPaymentIntent(...a),
}));
const tombstoneAbortedGatewayOrder = jest.fn();
jest.mock("../../lib/payments/checkout/gateway-intent", () => ({
  tombstoneAbortedGatewayOrder: (...a: unknown[]) =>
    tombstoneAbortedGatewayOrder(...a),
}));
jest.mock("../../hooks/use-toast", () => ({
  __esModule: true,
  useToast: jest.fn(),
}));
import { captureException } from "../fixtures/checkout-route-boundary";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { DriverAdapterError } from "@prisma/driver-adapter-utils";
import { POST } from "../../app/api/checkout/route";
import {
  busyRetryToast,
  fetchCheckoutWithBusyRetry,
} from "../../app/checkout/plans/utils";
import { getErrorToast } from "../../lib/errors/mapping/payment-error-toast-map";
import { replayByIdempotencyKey } from "../../lib/payments/operations/checkout-replay";

const actualPricing = jest.requireActual(
  "../../lib/payments/checkout/pricing",
) as typeof import("../../lib/payments/checkout/pricing");
const actualRevalidate = jest.requireActual(
  "../../lib/payments/checkout/revalidate",
) as typeof import("../../lib/payments/checkout/revalidate");

/** What Prisma 7 throws for a statement or COMMIT on a transaction past its timeout. */
function expiredTransaction(timeout: number, timeTaken: number) {
  return new Prisma.PrismaClientKnownRequestError(
    `\nInvalid \`tx.appointmentOccurrence.findFirst()\` invocation:\n\nTransaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was ${timeout} ms, however ${timeTaken} ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction.`,
    {
      code: "P2028",
      clientVersion: "7.10.1",
      meta: { operation: "query", timeout, timeTaken },
    },
  );
}
/** node-postgres past `query_timeout`; adapter-pg rethrows it unmapped. */
const queryReadTimeout = () => new Error("Query read timeout");

function webinarCheckout() {
  return new NextRequest("https://x.test/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "WEBINAR",
      eventId: "web-1",
      planId: "plan-1",
      paymentGateway: "RAZORPAY",
      clientIdempotencyKey: "key-1",
    }),
  });
}
function consultationCheckout() {
  return new NextRequest("https://x.test/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "CONSULTATION",
      planId: "plan-1",
      startsAt: "2026-12-01T10:00:00.000Z",
      endsAt: "2026-12-01T11:00:00.000Z",
      paymentGateway: "RAZORPAY",
      clientIdempotencyKey: "key-1",
    }),
  });
}

function soleCapture(): { level?: string; tags?: Record<string, string> } {
  expect(captureException).toHaveBeenCalledTimes(1);
  return captureException.mock.calls[0][1];
}

beforeEach(() => {
  jest.clearAllMocks();
  $transaction.mockReset();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  captureException.mockReturnValue("0123456789abcdef0123456789abcdef");
  calculateAmountAndValidate.mockImplementation(
    actualPricing.calculateAmountAndValidate,
  );
  revalidateInsideLock.mockImplementation(
    actualRevalidate.revalidateInsideLock,
  );
});

afterEach(() => jest.restoreAllMocks());

const DATABASE_BUSY_BODY = {
  errorType: "DATABASE_BUSY",
  retryAfter: 5,
  yourCardWasNotCharged: true,
};

describe("a database timeout before the booking commits answers a typed 503", () => {
  it("the pricing transaction past its 5 s timeout", async () => {
    $transaction.mockRejectedValueOnce(expiredTransaction(5000, 5610));

    const res = await POST(webinarCheckout());

    // The pricing transaction passes no options, so Prisma's 5 s default applies.
    expect($transaction.mock.calls[0]).toHaveLength(1);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject(DATABASE_BUSY_BODY);
    const context = soleCapture();
    expect(context.level).toBe("warning");
    expect(context.tags?.expected).toBe("true");
  });

  it("the in-lock revalidation past its 5 s timeout", async () => {
    calculateAmountAndValidate.mockResolvedValueOnce(PRICED);
    $transaction.mockRejectedValueOnce(expiredTransaction(5000, 5085));

    const res = await POST(webinarCheckout());

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject(DATABASE_BUSY_BODY);
    expect(soleCapture().level).toBe("warning");
  });

  it("a statement past the driver's read timeout", async () => {
    calculateAmountAndValidate.mockResolvedValueOnce(PRICED);
    $transaction.mockRejectedValueOnce(queryReadTimeout());

    const res = await POST(webinarCheckout());

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject(DATABASE_BUSY_BODY);
    expect(soleCapture().level).toBe("warning");
  });

  it("a read timeout in pricing, after the replay lookup found no earlier attempt", async () => {
    $transaction.mockRejectedValueOnce(queryReadTimeout());

    const res = await POST(webinarCheckout());

    expect(replayByIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(calculateAmountAndValidate).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject(DATABASE_BUSY_BODY);
    expect(soleCapture().level).toBe("warning");
  });

  it("the booking transaction past its timeout: rolled back, the minted order retired", async () => {
    calculateAmountAndValidate.mockResolvedValueOnce(PRICED);
    revalidateInsideLock.mockResolvedValueOnce(null);
    $transaction.mockRejectedValueOnce(expiredTransaction(25_000, 25_040));

    const res = await POST(consultationCheckout());

    expect($transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 25_000 }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject(DATABASE_BUSY_BODY);
    expect(soleCapture().level).toBe("warning");
    expect(cancelPaymentIntent).toHaveBeenCalledWith("order_1");
    expect(tombstoneAbortedGatewayOrder).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntent: "order_1" }),
    );
  });
});

describe("what keeps its answer", () => {
  it("a read timeout at the booking transaction stays a fault without the not-charged claim", async () => {
    calculateAmountAndValidate.mockResolvedValueOnce(PRICED);
    revalidateInsideLock.mockResolvedValueOnce(null);
    $transaction.mockRejectedValueOnce(queryReadTimeout());

    const res = await POST(consultationCheckout());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.yourCardWasNotCharged).toBeUndefined();
    expect(body.errorId).toBe("0123456789abcdef0123456789abcdef");
    expect(soleCapture().level).toBeUndefined();
  });

  it("a read timeout at the replay lookup is a fault without the not-charged claim, since the key may name a paid checkout", async () => {
    jest
      .mocked(replayByIdempotencyKey)
      .mockRejectedValueOnce(queryReadTimeout());

    const res = await POST(webinarCheckout());
    const body = await res.json();

    expect(calculateAmountAndValidate).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(body.errorType).toBe("UNKNOWN_ERROR");
    expect(body.yourCardWasNotCharged).toBeUndefined();
    expect(body.errorId).toBe("0123456789abcdef0123456789abcdef");
    expect(soleCapture().level).toBeUndefined();
  });

  it("a serialization conflict before the commit still answers 409", async () => {
    calculateAmountAndValidate.mockResolvedValueOnce(PRICED);
    $transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("write conflict", {
        code: "P2034",
        clientVersion: "7.10.1",
      }),
    );

    const res = await POST(webinarCheckout());

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      errorType: "SERIALIZATION_CONFLICT",
      retryAfter: 2,
      yourCardWasNotCharged: true,
    });
    const context = soleCapture();
    expect(context.level).toBe("warning");
    expect(context.tags?.expected).toBe("true");
  });

  it.each([
    [
      "a statement (P2034)",
      () =>
        new Prisma.PrismaClientKnownRequestError("write conflict", {
          code: "P2034",
          clientVersion: "7.10.1",
        }),
    ],
    [
      "the COMMIT (unmapped TransactionWriteConflict)",
      () => new DriverAdapterError({ kind: "TransactionWriteConflict" }),
    ],
  ])(
    "a serialization conflict at %s that exhausts the booking retries answers 409",
    async (_at, conflict) => {
      calculateAmountAndValidate.mockResolvedValueOnce(PRICED);
      revalidateInsideLock.mockResolvedValueOnce(null);
      $transaction.mockImplementation(async () => {
        throw conflict();
      });

      const res = await POST(consultationCheckout());

      // One attempt plus the three Serializable retries, each rolled back.
      expect($transaction).toHaveBeenCalledTimes(4);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        errorType: "SERIALIZATION_CONFLICT",
        retryAfter: 2,
        yourCardWasNotCharged: true,
      });
      const context = soleCapture();
      expect(context.level).toBe("warning");
      expect(context.tags?.expected).toBe("true");
      expect(cancelPaymentIntent).toHaveBeenCalledWith("order_1");
    },
  );

  it("an unrelated failure still answers 500 and is reported as a fault", async () => {
    calculateAmountAndValidate.mockResolvedValueOnce(PRICED);
    $transaction.mockRejectedValueOnce(
      new Error("Connection terminated unexpectedly"),
    );

    const res = await POST(webinarCheckout());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.errorType).toBe("UNKNOWN_ERROR");
    expect(body.yourCardWasNotCharged).toBeUndefined();
    const context = soleCapture();
    expect(context.level).toBeUndefined();
    expect(context.tags?.expected).toBe("false");
  });
});

describe("the checkout client on the 503", () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ["nextTick"] }));
  afterEach(() => jest.useRealTimers());

  it("waits the advised pause, retries with the same request, and says the system is busy", async () => {
    $transaction.mockRejectedValueOnce(expiredTransaction(5000, 5610));
    const succeeded = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    const attempt = jest
      .fn<Promise<Response>, []>()
      .mockImplementationOnce(() => POST(webinarCheckout()))
      .mockResolvedValueOnce(succeeded);
    const notify = jest.fn();

    const pending = fetchCheckoutWithBusyRetry(attempt, notify);
    await jest.advanceTimersByTimeAsync(6100);

    expect((await pending).status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(5, "DATABASE_BUSY");
    const during = busyRetryToast(5, "DATABASE_BUSY");
    expect(during.title).not.toMatch(/one step ahead/i);
    expect(during.description).toContain("not been charged");
    const after = getErrorToast("DATABASE_BUSY");
    expect(after.title).not.toBe("Something went wrong");
    expect(after.description).toMatch(/not charged/i);
  });
});
