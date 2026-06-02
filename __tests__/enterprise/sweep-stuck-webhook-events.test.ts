/**
 * @jest-environment node
 */

/**
 * #785 (task #10) — B5 stuck-webhook sweeper. Re-drives WebhookEvent rows left
 * processed=false after an after()-callback crash, reconstructing the envelope
 * the per-event schemas require (entity/account_id/contains/created_at) and
 * routing through the real dispatch. Pins the loop + reconstruction + the
 * success/fail/throw accounting.
 */

// Factories create the jest.fn()s inline (retrieved via the mocked modules
// below) — referencing outer consts here would hit import-hoisting init order.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webhookEvent: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
  },
}));
jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  processRazorpayWebhookEvent: jest.fn(),
}));

import prisma from "../../lib/prisma";
import { processRazorpayWebhookEvent } from "../../app/api/webhooks/razorpay-dispatch";
import { sweepStuckWebhookEvents } from "../../scripts/cleanup/sweep-stuck-webhook-events";

const mockWe = (prisma as unknown as {
  webhookEvent: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
}).webhookEvent;
const mockProcess = processRazorpayWebhookEvent as jest.Mock;

const stuckRow = (over: Record<string, unknown> = {}) => ({
  eventId: "payment.captured:pay_1",
  eventType: "payment.captured",
  payload: { payment: { entity: { id: "pay_1" } } },
  receivedAt: new Date("2026-06-01T00:00:00Z"),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockWe.update.mockResolvedValue({});
});

describe("sweepStuckWebhookEvents (#785)", () => {
  it("re-drives a stuck event and reconstructs the full envelope", async () => {
    mockWe.findMany.mockResolvedValue([stuckRow()]);
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({ error: null, processed: true });

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r).toMatchObject({ scanned: 1, recovered: 1, stillFailing: 0 });
    // only razorpay, only the after()-crash signature (processed=false+error=null)
    expect(mockWe.findMany.mock.calls[0][0].where).toMatchObject({
      provider: "razorpay",
      processed: false,
      error: null,
    });
    // envelope reconstruction supplies the fields the schemas demand
    const [env, evType, evId] = mockProcess.mock.calls[0];
    expect(env).toMatchObject({
      entity: "event",
      event: "payment.captured",
      contains: ["payment"], // top-level payload keys
      payload: { payment: { entity: { id: "pay_1" } } },
    });
    expect(typeof env.account_id).toBe("string");
    expect(typeof env.created_at).toBe("number");
    expect(evType).toBe("payment.captured");
    expect(evId).toBe("payment.captured:pay_1");
  });

  it("a re-drive that still errors counts as stillFailing, not recovered", async () => {
    mockWe.findMany.mockResolvedValue([stuckRow()]);
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({ error: "handler boom", processed: true });

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r.recovered).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(r.errors[0]).toContain("handler boom");
  });

  it("a throw mid-dispatch is caught + the row force-marked (never re-swept forever)", async () => {
    mockWe.findMany.mockResolvedValue([stuckRow()]);
    mockProcess.mockRejectedValue(new Error("kaboom"));

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r.stillFailing).toBe(1);
    expect(mockWe.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId: "payment.captured:pay_1" },
        data: expect.objectContaining({ processed: true }),
      }),
    );
  });

  it("empty scan → no-op", async () => {
    mockWe.findMany.mockResolvedValue([]);
    const r = await sweepStuckWebhookEvents();
    expect(r).toMatchObject({ scanned: 0, recovered: 0, stillFailing: 0 });
    expect(mockProcess).not.toHaveBeenCalled();
  });
});
