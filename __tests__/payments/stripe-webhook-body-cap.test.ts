/**
 * @jest-environment node
 */

/**
 * #1582 F-P1-01a — the Stripe webhook read `req.text()` uncapped while the
 * Razorpay route refuses on Content-Length and reads through
 * `readBodyWithinCap` (256 KiB). Both layers now guard the Stripe route too,
 * and neither reaches `constructEvent`: a declared 300 KiB is refused unread,
 * and an undeclared 300 KiB stream is abandoned at the cap.
 */

jest.mock("@sentry/nextjs", () => ({
  setTag: jest.fn(),
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const constructEvent = jest.fn();
jest.mock("../../lib/payments/core/stripe", () => ({
  getStripeClient: () => ({ webhooks: { constructEvent } }),
  stripeClient: null,
}));
// The rest of the webhook utils graph is boundary-mocked; only
// verifyWebhookSignature runs for real.
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/payments/core/razorpay", () => ({}));
jest.mock("../../lib/novu", () => ({}));
jest.mock("../../lib/novu/org-workflows", () => ({}));
jest.mock("../../lib/novu/service", () => ({}));
jest.mock("../../lib/referrals/service", () => ({}));
jest.mock("../../lib/api/organizations/wallet", () => ({}));
jest.mock("../../lib/payments/payouts", () => ({}));
jest.mock("../../lib/payments/webhooks/handlers", () => ({}));
jest.mock("../../lib/payments/operations/reversal-engine", () => ({}));
jest.mock("../../lib/payments/tax/tds-service", () => ({}));
jest.mock("../../lib/payments/operations/refund", () => ({}));
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({}));
jest.mock("../../lib/enterprise/system-events", () => ({}));
jest.mock("../../lib/email", () => ({}));
jest.mock("../../lib/email/send-to-recipients", () => ({}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/webhooks/stripe/route";

const KIB = 1024;

function streamOf(totalBytes: number, chunkBytes = 64 * KIB) {
  let remaining = totalBytes;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, remaining);
      remaining -= size;
      controller.enqueue(new Uint8Array(size));
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
});

describe("Stripe webhook body cap (#1582 F-P1-01a)", () => {
  it("a declared 300 KiB body is refused 413 before any signature work", async () => {
    const req = new NextRequest("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "content-length": String(300 * KIB),
        "stripe-signature": "t=1,v1=deadbeef",
      },
      body: "{}",
    });

    const res = await POST(req);

    expect(res.status).toBe(413);
    expect(constructEvent).not.toHaveBeenCalled();
  });

  it("an undeclared 300 KiB stream is abandoned at the cap and answered 413", async () => {
    const req = new NextRequest("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
      body: streamOf(300 * KIB),
      // undici needs the streaming-body opt-in.
      duplex: "half",
    });

    const res = await POST(req);

    expect(res.status).toBe(413);
    expect(constructEvent).not.toHaveBeenCalled();
  });
});
