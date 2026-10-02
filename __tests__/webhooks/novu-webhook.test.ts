/**
 * @jest-environment node
 */

import crypto from "node:crypto";
import type { NextRequest } from "next/server";

jest.mock("@sentry/nextjs", () => ({
  setTag: jest.fn(),
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    notificationOutbox: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/webhooks/event-log", () => ({
  isDbHealthy: jest.fn().mockResolvedValue(true),
  logWebhookEvent: jest.fn(),
  markWebhookEventProcessed: jest.fn().mockResolvedValue(undefined),
}));

import prisma from "../../lib/prisma";
import { recordSystemEvent } from "../../lib/enterprise/system-events";
import {
  isDbHealthy,
  logWebhookEvent,
  markWebhookEventProcessed,
} from "../../lib/webhooks/event-log";
import { POST } from "../../app/api/webhooks/novu/route";

const SECRET = "test-novu-webhook-secret";

function makeRequest(
  body: Record<string, unknown>,
  headersInit: Record<string, string> = {},
): NextRequest {
  const rawBody = JSON.stringify(body);
  const headers = new Headers(headersInit);
  const encoder = new TextEncoder();
  const bytes = encoder.encode(rawBody);
  return {
    headers,
    text: async () => rawBody,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  } as unknown as NextRequest;
}

function signHmac(rawBody: string, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

describe("POST /api/webhooks/novu (#399)", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, NOVU_WEBHOOK_SECRET: SECRET };
    (isDbHealthy as jest.Mock).mockResolvedValue(true);
    (logWebhookEvent as jest.Mock).mockResolvedValue({
      isNew: true,
      claim: { claimedAt: new Date("2026-10-02T00:00:00Z") },
    });
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it("returns 500 when NOVU_WEBHOOK_SECRET is not configured", async () => {
    delete process.env.NOVU_WEBHOOK_SECRET;
    const res = await POST(makeRequest({ type: "message.sent" }));
    expect(res.status).toBe(500);
  });

  it("returns 401 and records a WARN system event when signature header is missing or invalid", async () => {
    const payload = { id: "evt_1", type: "message.sent" };
    const missingRes = await POST(makeRequest(payload));
    expect(missingRes.status).toBe(401);

    const invalidRes = await POST(
      makeRequest(payload, { "x-novu-signature": "deadbeef" }),
    );
    expect(invalidRes.status).toBe(401);
    expect(recordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "WEBHOOK",
        severity: "WARN",
      }),
    );
    expect(logWebhookEvent).not.toHaveBeenCalled();
  });

  it("skips duplicate events via logWebhookEvent deduplication", async () => {
    (logWebhookEvent as jest.Mock).mockResolvedValueOnce({
      isNew: false,
      claim: undefined,
    });
    const payload = {
      id: "evt_dup_1",
      type: "message.failed",
      transactionId: "tx_dup_1",
    };
    const raw = JSON.stringify(payload);
    const res = await POST(
      makeRequest(payload, { "x-novu-signature": signHmac(raw) }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
    expect(prisma.notificationOutbox.updateMany).not.toHaveBeenCalled();
  });

  it("updates NotificationOutbox.lastError, records system event, and marks processed on delivery failure", async () => {
    const payload = {
      id: "evt_fail_1",
      type: "message.failed",
      transactionId: "tx_fail_1",
      subscriberId: "user_1",
      workflowId: "booking-confirmed",
      error: "Provider rejected message",
    };
    const raw = JSON.stringify(payload);
    const res = await POST(
      makeRequest(payload, {
        "x-novu-signature": `sha256=${signHmac(raw)}`,
      }),
    );

    expect(res.status).toBe(200);
    expect(prisma.notificationOutbox.updateMany).toHaveBeenCalledWith({
      where: { transactionId: "tx_fail_1" },
      data: { lastError: "Provider rejected message" },
    });
    expect(recordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "WEBHOOK",
        severity: "WARN",
        context: expect.objectContaining({
          provider: "novu",
          eventId: "evt_fail_1",
          transactionId: "tx_fail_1",
        }),
      }),
    );
    expect(markWebhookEventProcessed).toHaveBeenCalledWith(
      "evt_fail_1",
      undefined,
      expect.objectContaining({ claimedAt: expect.any(Date) }),
    );
  });

  it("marks NotificationOutbox row SENT on delivered event", async () => {
    const payload = {
      id: "evt_sent_1",
      type: "message.sent",
      transactionId: "tx_sent_1",
      status: "sent",
    };
    const raw = JSON.stringify(payload);
    const res = await POST(
      makeRequest(payload, { "x-novu-signature": signHmac(raw) }),
    );

    expect(res.status).toBe(200);
    expect(prisma.notificationOutbox.updateMany).toHaveBeenCalledWith({
      where: { transactionId: "tx_sent_1", status: "PENDING" },
      data: expect.objectContaining({
        status: "SENT",
        sentAt: expect.any(Date),
        nextRetryAt: null,
        lastError: null,
      }),
    });
    expect(markWebhookEventProcessed).toHaveBeenCalledWith(
      "evt_sent_1",
      undefined,
      expect.objectContaining({ claimedAt: expect.any(Date) }),
    );
  });
});
