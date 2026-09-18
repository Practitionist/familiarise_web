/**
 * @jest-environment node
 */

/**
 * #1708 — a PENDING payment whose gateway id the gateway does not know is a
 * terminal per-row outcome, not a run failure. Thirteen seeded rows with UUID
 * intents answered 500 on every five-minute tick for a week, occupying the
 * ticker's `failed` list so a real outage would have been invisible. The
 * route now answers 207 with an `unresolvableCount`, keeps `errors` empty,
 * and leaves 500 for a gateway that could not be reached at all. Neither case
 * writes `Payment` state (ADR 21).
 */

// The script imports the SDK lazily and constructs it, so the mock is a class
// with the one method the pin drives, exposed statically for the assertions.
jest.mock("stripe", () => ({
  __esModule: true,
  default: class StripeMock {
    static retrieve = jest.fn();
    paymentIntents = { retrieve: StripeMock.retrieve };
    checkout = { sessions: { retrieve: jest.fn() } };
  },
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  LONG_JOB_TTL_MS: 1,
  CronLockHeldError: class CronLockHeldError extends Error {},
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: jest.fn(),
  MaintenanceActiveError: class MaintenanceActiveError extends Error {},
}));

jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  routeCapturedPayment: jest.fn(),
}));

import type { NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import Stripe from "stripe";
import prisma from "../../lib/prisma";
import { POST } from "../../app/api/cleanup/reconcile-payment-status/route";

const mockRetrieve = (Stripe as unknown as { retrieve: jest.Mock }).retrieve;
const mockCaptureMessage = Sentry.captureMessage as jest.Mock;

const SECRET = "test-cron-secret";

function request(): NextRequest {
  const headers = new Headers({ authorization: `Bearer ${SECRET}` });
  return {
    headers,
    nextUrl: { searchParams: new URLSearchParams() },
  } as unknown as NextRequest;
}

const pendingStripeRow = {
  id: "pay-1",
  paymentGateway: "STRIPE",
  paymentIntent: "103e6474-6cc3-4d37-9673-25af4b1dd566",
  paymentStatus: "PENDING",
  createdAt: new Date("2026-09-14T00:00:00Z"),
  user: null,
  appointment: null,
};

describe("reconcile-payment-status — an unknown gateway id (#1708)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([
      pendingStripeRow,
    ]);
  });

  it("counts a resource_missing row as unresolvable and answers 207", async () => {
    mockRetrieve.mockRejectedValue(
      Object.assign(new Error("No such payment_intent: '103e6474-…'"), {
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        statusCode: 404,
      }),
    );

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(207);
    expect(body.success).toBe(true);
    expect(body.errors).toEqual([]);
    expect(body.unresolvableCount).toBe(1);
    expect(body.unresolvable).toEqual(["pay-1"]);
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining("1 pending payments"),
      expect.objectContaining({
        level: "warning",
        fingerprint: ["reconcile-payment-status", "unresolvable"],
        extra: { unresolvable: ["pay-1"] },
      }),
    );
  });

  it("keeps a gateway that cannot be reached as a run failure — 500", async () => {
    mockRetrieve.mockRejectedValue(new Error("ECONNRESET"));

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain("pay-1");
    expect(body.unresolvableCount).toBe(0);
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});
