/**
 * @jest-environment node
 */

// Event-lock contention leaves POST /api/checkout as a 409 with retryAfter, through the real checkout core.

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/payments/checkout/pricing", () => ({
  calculateAmountAndValidate: jest.fn(async () => ({
    amount: 100_000,
    originalAmount: 100_000,
    taxAmount: 0,
    currency: "INR",
    creditsApplied: 0,
  })),
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
import "../fixtures/checkout-route-boundary";
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
