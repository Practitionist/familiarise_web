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
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));
jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  processRazorpayWebhookEvent: jest.fn(),
}));
jest.mock("../../lib/stream/webhook-dispatch", () => ({
  processStreamEvent: jest.fn(),
}));
jest.mock("../../lib/webhooks/novu-handler", () => ({
  processNovuWebhookPayload: jest.fn(),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn((_job: string, _opts: unknown, fn: () => unknown) =>
    fn(),
  ),
  CronLockHeldError: class CronLockHeldError extends Error {},
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
  LONG_JOB_TTL_MS: 35 * 60 * 1000,
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryMessage: jest.fn(),
}));

import prisma from "../../lib/prisma";
import { reportSentryMessage } from "../../lib/observability/report";
import { processNovuWebhookPayload } from "../../lib/webhooks/novu-handler";
import { processRazorpayWebhookEvent } from "../../app/api/webhooks/razorpay-dispatch";
import { sweepStuckWebhookEvents } from "../../scripts/cleanup/sweep-stuck-webhook-events";

const mockWe = {
  findMany: prisma.webhookEvent.findMany as jest.Mock,
  findUnique: prisma.webhookEvent.findUnique as jest.Mock,
  update: prisma.webhookEvent.update as jest.Mock,
  updateMany: prisma.webhookEvent.updateMany as jest.Mock,
};
const mockProcess = processRazorpayWebhookEvent as jest.Mock;
const mockProcessNovu = processNovuWebhookPayload as jest.Mock;

const stuckRow = (over: Record<string, unknown> = {}) => ({
  eventId: "payment.captured:pay_1",
  eventType: "payment.captured",
  provider: "razorpay",
  payload: { payment: { entity: { id: "pay_1" } } },
  receivedAt: new Date("2026-06-01T00:00:00Z"),
  claimedAt: null as Date | null | undefined,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockWe.update.mockResolvedValue({});
  mockWe.updateMany.mockResolvedValue({ count: 1 });
});

describe("sweepStuckWebhookEvents", () => {
  it("a LOST claim (claimedAt raced) skips the re-drive entirely", async () => {
    const ev = stuckRow();
    mockWe.findMany.mockResolvedValue([ev]);
    mockWe.updateMany.mockResolvedValue({ count: 0 });

    const result = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(processRazorpayWebhookEvent).not.toHaveBeenCalled();
    expect(result.recovered).toBe(0);
  });

  it("the claim CAS keys strictly on processed: false and exact claimedAt, resetting error to null", async () => {
    const ev = stuckRow();
    mockWe.findMany.mockResolvedValue([ev]);
    mockWe.updateMany.mockResolvedValue({ count: 1 });

    await sweepStuckWebhookEvents({ staleMinutes: 6 });

    const [claim] = mockWe.updateMany.mock.calls;
    expect(claim[0].where).toEqual({
      eventId: ev.eventId,
      processed: false,
      claimedAt: ev.claimedAt,
    });
    expect(claim[0].data).toEqual({
      claimedAt: expect.any(Date),
      error: null,
      deferCount: { increment: 1 },
    });
    expect(claim[0].where.receivedAt).toBeUndefined();
    expect(claim[0].data.receivedAt).toBeUndefined();
  });

  it("re-drives a stuck event across razorpay, stream, and novu providers", async () => {
    mockWe.findMany.mockResolvedValue([stuckRow()]);
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({ error: null, processed: true });

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r).toMatchObject({ scanned: 1, recovered: 1, stillFailing: 0 });
    expect(reportSentryMessage).not.toHaveBeenCalled();

    const where = mockWe.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      provider: { in: ["razorpay", "stream", "novu"] },
    });
    expect(where.OR).toEqual([
      { processed: false, error: null },
      expect.objectContaining({ error: { not: null } }),
    ]);
    expect(where.OR[1].receivedAt).toHaveProperty("gte");

    const [env, evType, evId] = mockProcess.mock.calls[0];
    expect(env).toMatchObject({
      entity: "event",
      event: "payment.captured",
      contains: ["payment"],
      payload: { payment: { entity: { id: "pay_1" } } },
    });
    expect(typeof env.account_id).toBe("string");
    expect(typeof env.created_at).toBe("number");
    expect(evType).toBe("payment.captured");
    expect(evId).toBe("payment.captured:pay_1");
  });

  it("re-drives a stuck Novu webhook event through processNovuWebhookPayload", async () => {
    const novuRow = stuckRow({
      eventId: "evt_novu_stuck_1",
      eventType: "message.sent",
      provider: "novu",
      payload: {
        id: "evt_novu_stuck_1",
        type: "message.sent",
        transactionId: "tx_1",
      },
    });
    mockWe.findMany.mockResolvedValue([novuRow]);
    mockProcessNovu.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({ error: null, processed: true });

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r).toMatchObject({ scanned: 1, recovered: 1, stillFailing: 0 });
    expect(mockProcessNovu).toHaveBeenCalledWith(
      expect.objectContaining({ type: "message.sent", transactionId: "tx_1" }),
      "evt_novu_stuck_1",
    );
  });

  it("a re-drive that still errors counts as stillFailing, not recovered", async () => {
    mockWe.findMany.mockResolvedValue([stuckRow()]);
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({
      error: "handler boom",
      processed: false,
    });

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r.recovered).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(r.errors[0]).toContain("handler boom");
    expect(reportSentryMessage).toHaveBeenCalledTimes(1);
    expect(reportSentryMessage).toHaveBeenCalledWith(
      expect.stringContaining("1 re-driven webhook event(s) still failing"),
      expect.objectContaining({ expected: false, level: "error" }),
    );
  });

  it("a throw mid-dispatch is caught and CAS-updated with rotated claimedAt + error", async () => {
    mockWe.findMany.mockResolvedValue([stuckRow()]);
    mockProcess.mockRejectedValue(new Error("kaboom"));

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r.stillFailing).toBe(1);
    expect(mockWe.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          eventId: "payment.captured:pay_1",
          processed: false,
          claimedAt: expect.any(Date),
        },
        data: expect.objectContaining({
          processed: false,
          processedAt: null,
          claimedAt: expect.any(Date),
          error: "sweep-failed: kaboom",
        }),
      }),
    );
  });

  it("empty scan -> no-op", async () => {
    mockWe.findMany.mockResolvedValue([]);
    const r = await sweepStuckWebhookEvents();
    expect(r).toMatchObject({ scanned: 0, recovered: 0, stillFailing: 0 });
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it("a re-drive that stays deferred is counted as deferred, not recovered", async () => {
    const recent = new Date(Date.now() - 60 * 60_000);
    mockWe.findMany.mockResolvedValue([
      stuckRow({ eventId: "refund.created:rfnd_1", receivedAt: recent }),
    ]);
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({ error: null, processed: false });

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r).toMatchObject({
      scanned: 1,
      recovered: 0,
      stillFailing: 0,
      deferred: 1,
      gaveUp: 0,
    });
    expect(mockWe.update).not.toHaveBeenCalled();
  });

  it("a deferred event past the give-up cap is terminally marked via CAS updateMany with rotated claimedAt", async () => {
    const old = new Date(Date.now() - 200 * 60 * 60_000);
    mockWe.findMany.mockResolvedValue([
      stuckRow({ eventId: "refund.created:rfnd_2", receivedAt: old }),
    ]);
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({ error: null, processed: false });

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r).toMatchObject({ deferred: 0, gaveUp: 1, recovered: 0 });
    expect(mockWe.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          eventId: "refund.created:rfnd_2",
          processed: false,
          claimedAt: expect.any(Date),
        },
        data: expect.objectContaining({
          processed: false,
          processedAt: null,
          claimedAt: expect.any(Date),
          error: "gave up: payment never arrived",
        }),
      }),
    );
    expect(r.errors[0]).toContain("gave up");
  });
});
