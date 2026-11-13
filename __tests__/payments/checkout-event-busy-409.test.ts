/**
 * @jest-environment node
 */

// Event-lock contention leaves POST /api/checkout as a 409 with retryAfter, through the real checkout core.

jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "buyer" } },
  })),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  checkoutLimiter: { limit: jest.fn() },
}));
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {},
  withCircuitBreaker: (fn: () => unknown) => fn(),
  checkRedisHealth: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/payments/operations/checkout-replay", () => ({
  replayByIdempotencyKey: jest.fn(async () => null),
  checkoutRequestFingerprint: () => "fp",
}));
jest.mock("../../lib/payments/tax/checkout-context", () => ({
  resolveCheckoutTaxContext: jest.fn(async () => ({ buyerCountry: "IN" })),
}));
jest.mock("../../lib/payments/gateway-router", () => ({
  routeGateway: jest.fn(() => ({ gateway: "RAZORPAY", reason: "domestic" })),
}));
jest.mock("../../schemas/checkout", () => ({
  checkoutSchema: { parse: (body: Record<string, unknown>) => ({ ...body }) },
  consumerBuyerStateSchema: { parse: jest.fn() },
}));
jest.mock("../../lib/payments/checkout/org-funding", () => ({
  resolveOrgFunding: jest.fn(async (validatedData: unknown) => ({
    validatedData,
    organizationId: null,
    programAssignmentId: null,
    fundingProgramId: null,
    callerMembershipId: null,
    referralCreditsDropped: false,
    billingAccountId: null,
    fundingSource: null,
    creditEffectiveLimit: null,
  })),
  readInvoiceExposurePaise: jest.fn(),
  assertWithinInvoiceCreditLimit: jest.fn(),
}));
jest.mock("../../lib/payments/checkout/pricing", () => ({
  calculateAmountAndValidate: jest.fn(async () => ({
    amount: 100_000,
    originalAmount: 100_000,
    taxAmount: 0,
    currency: "INR",
    creditsApplied: 0,
  })),
}));
jest.mock("../../lib/payments/core/saved-card-customer", () => ({
  savedCardCustomerId: jest.fn(async () => undefined),
}));
const acquireCheckoutLock = jest.fn();
jest.mock("../../lib/payments/checkout/locks", () => ({
  getPlanDataForLock: jest.fn(async () => ({})),
  acquireCheckoutLock: (...a: unknown[]) => acquireCheckoutLock(...a),
  releaseCheckoutLock: jest.fn(),
  lockBuyerSeatAtoms: jest.fn(),
}));
jest.mock("../../lib/payments/checkout/commit", () => ({
  commitCheckout: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  startSpan: (_opts: unknown, fn: () => unknown) => fn(),
  getCurrentScope: () => ({ setTag: jest.fn() }),
  metrics: { count: jest.fn() },
}));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/checkout/route";
import { EventCheckoutBusyError } from "../../utils/appointmentlock";

it("answers event-lock contention 409 EVENT_CHECKOUT_BUSY with retryAfter", async () => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  acquireCheckoutLock.mockRejectedValue(new EventCheckoutBusyError("WEBINAR"));

  const res = await POST(
    new NextRequest("https://x.test/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appointmentType: "WEBINAR",
        eventId: "web-1",
        planId: "plan-1",
        paymentGateway: "RAZORPAY",
      }),
    }),
  );

  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    errorType: "EVENT_CHECKOUT_BUSY",
    retryAfter: 10,
    yourCardWasNotCharged: true,
  });
});

it("answers a same-key double submit with the first attempt's replay, not busy", async () => {
  const { NextResponse } = await import("next/server");
  const { replayByIdempotencyKey } = jest.requireMock(
    "../../lib/payments/operations/checkout-replay",
  );
  replayByIdempotencyKey
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(NextResponse.json({ success: true, reused: true }));
  acquireCheckoutLock.mockRejectedValue(new EventCheckoutBusyError("WEBINAR"));

  const res = await POST(
    new NextRequest("https://x.test/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appointmentType: "WEBINAR",
        eventId: "web-1",
        planId: "plan-1",
        paymentGateway: "RAZORPAY",
        clientIdempotencyKey: "key-1",
      }),
    }),
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ success: true, reused: true });
});
