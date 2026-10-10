/**
 * @jest-environment node
 */

/**
 * #1134 P1-2 — the three-state machine in `logWebhookEvent`, and the two ways it
 * failed open.
 *
 * The states are encoded on `processed` + `error`:
 *   processed=true  + no error  -> SUCCESS      skip, idempotent
 *   processed=true  + error set -> FAILED       allow retry
 *   processed=false + no error  -> IN-PROGRESS  skip, another worker has it
 *
 * IN-PROGRESS has a five-minute staleness escape so a crashed `after()` cannot
 * wedge an event forever. Two defects lived in that escape:
 *
 *   1. The retry path reset `processed` and `error` but NOT the claim stamp.
 *      The staleness check measures the claim's age, so a retried row was
 *      instantly older than the threshold — the in-progress guard fell open for
 *      exactly the rows it exists to protect, and the sweeper could pick up an
 *      event another worker was mid-way through. Since #1589 M-P0-03 that
 *      stamp is `claimedAt`, never `receivedAt`, so a re-drive cannot reset
 *      the sweeper's 168 h give-up.
 *   2. Both escapes read the row, decided, then wrote. Check-then-act: two
 *      workers both observe "stale", both write, both believe they own it, and
 *      the handler runs twice. For an attendance write or a moderation action
 *      that is a duplicate side effect, not a no-op.
 *
 * Both are now conditional writes whose row count IS the claim.
 */

const mockFindUnique = jest.fn();
const mockUpdateMany = jest.fn();
const mockCreate = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webhookEvent: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
      create: (...a: unknown[]) => mockCreate(...a),
      update: jest.fn(),
    },
  },
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

import prisma from "../../lib/prisma";
import { scrubWebhookPayload } from "../../lib/logging/webhook-scrub";
import { reclaimStaleProcessingWebhookEvent } from "../../lib/stream/webhook-receipt";
import {
  logWebhookEvent,
  markWebhookEventProcessed,
} from "../../lib/webhooks/event-log";

const SIX_MINUTES_AGO = new Date(Date.now() - 6 * 60 * 1000);
const ONE_MINUTE_AGO = new Date(Date.now() - 60 * 1000);

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockCreate.mockResolvedValue({ id: "new" });
});

describe("the FAILED -> retry path", () => {
  it("moves claimedAt forward and leaves receivedAt alone", async () => {
    mockFindUnique.mockResolvedValue({
      id: "r1",
      processed: false,
      error: "boom",
      receivedAt: SIX_MINUTES_AGO,
      claimedAt: null,
    });

    const res = await logWebhookEvent("stream", "e1", "call.ended", {});

    expect(res.isNew).toBe(true);
    const data = mockUpdateMany.mock.calls[0][0].data;
    expect(data.claimedAt).toBeInstanceOf(Date);
    expect(data.claimedAt.getTime()).toBeGreaterThan(SIX_MINUTES_AGO.getTime());
    expect(data.receivedAt).toBeUndefined();
  });

  it("claims conditionally, so a racing worker loses", async () => {
    mockFindUnique.mockResolvedValue({
      id: "r1",
      processed: false,
      error: "boom",
      receivedAt: SIX_MINUTES_AGO,
    });
    mockUpdateMany.mockResolvedValue({ count: 0 });

    const res = await logWebhookEvent("stream", "e1", "call.ended", {});

    expect(res.isNew).toBe(false);
    expect(mockUpdateMany.mock.calls[0][0].where).toMatchObject({
      eventId: "e1",
      error: { not: null },
    });
  });

  it("never reclaims terminal permanent: or gave up: webhook errors", async () => {
    for (const terminalError of [
      "permanent: schema mismatch",
      "gave up: payment never arrived",
    ]) {
      mockFindUnique.mockResolvedValueOnce({
        id: "r1",
        processed: false,
        error: terminalError,
        receivedAt: SIX_MINUTES_AGO,
      });

      const res = await logWebhookEvent("stream", "e1", "call.ended", {});

      expect(res).toEqual({ isNew: false, eventRecordId: "r1" });
    }
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

describe("the IN-PROGRESS staleness escape", () => {
  it("scopes the claim to processed: false and exact claimedAt", async () => {
    mockFindUnique.mockResolvedValue({
      id: "r1",
      processed: false,
      error: null,
      receivedAt: new Date(Date.now() - 60 * 60 * 1000),
      claimedAt: SIX_MINUTES_AGO,
    });

    const res = await logWebhookEvent("stream", "e1", "call.ended", {});

    expect(res.isNew).toBe(true);
    expect(mockUpdateMany.mock.calls[0][0].where).toEqual({
      eventId: "e1",
      processed: false,
      claimedAt: SIX_MINUTES_AGO,
    });
  });

  it("yields to the winner when the row moved under it", async () => {
    mockFindUnique.mockResolvedValue({
      id: "r1",
      processed: false,
      error: null,
      receivedAt: SIX_MINUTES_AGO,
    });
    mockUpdateMany.mockResolvedValue({ count: 0 });

    const res = await logWebhookEvent("stream", "e1", "call.ended", {});

    expect(res.isNew).toBe(false);
  });

  it("still refuses a genuinely in-flight event", async () => {
    mockFindUnique.mockResolvedValue({
      id: "r1",
      processed: false,
      error: null,
      receivedAt: SIX_MINUTES_AGO,
      claimedAt: ONE_MINUTE_AGO,
    });

    const res = await logWebhookEvent("stream", "e1", "call.ended", {});

    expect(res.isNew).toBe(false);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

describe("reclaimStaleProcessingWebhookEvent CAS modes", () => {
  it("Mode 1 matches exact claimedAt (never OR claimedAt: null when prior stamp existed), requires processed: false, and resets error: null", async () => {
    const prior = new Date("2026-10-01T10:00:00Z");
    const res = await reclaimStaleProcessingWebhookEvent("ev_m1", prior);

    expect(res.reclaimed).toBe(true);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: {
        eventId: "ev_m1",
        processed: false,
        claimedAt: prior,
      },
      data: {
        claimedAt: expect.any(Date),
        error: null,
      },
    });
  });

  it("Mode 2 filters processed: false with age cutoff and resets error: null", async () => {
    const res = await reclaimStaleProcessingWebhookEvent("ev_m2", {
      staleThresholdMs: 60_000,
    });

    expect(res.reclaimed).toBe(true);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: {
        eventId: "ev_m2",
        processed: false,
        error: null,
        deferCount: { lt: 5 },
        OR: [
          { claimedAt: { lt: expect.any(Date) } },
          { claimedAt: null, receivedAt: { lt: expect.any(Date) } },
        ],
      },
      data: {
        claimedAt: expect.any(Date),
        error: null,
        deferCount: { increment: 1 },
      },
    });
  });
});

describe("the SUCCESS path stays idempotent", () => {
  it("skips a row already processed without error", async () => {
    mockFindUnique.mockResolvedValue({
      id: "r1",
      processed: true,
      error: null,
      receivedAt: SIX_MINUTES_AGO,
    });

    const res = await logWebhookEvent("stream", "e1", "call.ended", {});

    expect(res.isNew).toBe(false);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

describe("closing a delivery out", () => {
  const mockUpdate = jest.fn();
  beforeEach(() => {
    prisma.webhookEvent.update = mockUpdate;
    mockUpdate.mockResolvedValue({});
  });

  it("records success with processed: true, processedAt Date, null error, and non-null claimedAt", async () => {
    await markWebhookEventProcessed("e1", undefined);
    const data = mockUpdate.mock.calls[0][0].data;
    expect(data.processed).toBe(true);
    expect(data.processedAt).toBeInstanceOf(Date);
    expect(data.claimedAt).toBeInstanceOf(Date);
    expect(data.error).toBeNull();
  });

  it("stamps non-null claimedAt even when claim.claimedAt is null", async () => {
    await markWebhookEventProcessed("e1", undefined, { claimedAt: null });
    const data = mockUpdateMany.mock.calls[0][0].data;
    expect(data.claimedAt).toBeInstanceOf(Date);
    expect(data.processed).toBe(true);
  });

  it("does NOT let an empty error message read as success and keeps processed: false / processedAt: null", async () => {
    await markWebhookEventProcessed("e1", "");
    const data = mockUpdate.mock.calls[0][0].data;
    expect(data.error).toBe("");
    expect(data.processed).toBe(false);
    expect(data.processedAt).toBeNull();
  });

  it("keeps a real error message intact with processed: false", async () => {
    await markWebhookEventProcessed("e1", "handler exploded");
    const data = mockUpdate.mock.calls[0][0].data;
    expect(data.error).toBe("handler exploded");
    expect(data.processed).toBe(false);
    expect(data.processedAt).toBeNull();
  });
});

describe("scrubWebhookPayload PII redaction", () => {
  it("redacts sensitive email/payment/network keys case-insensitively while preserving array shape", () => {
    const scrubbed = scrubWebhookPayload({
      to: ["alice@example.com", "bob@example.com"],
      from: "sender@example.com",
      Reply_To: "reply@example.com",
      customer_email: "cust@example.com",
      customer_phone: "+919999999999",
      contact: "+918888888888",
      vpa: "user@okaxis",
      IP: "203.0.113.10",
      user_agent: "Mozilla/5.0",
      eventType: "email.bounced",
    });

    expect(scrubbed).toEqual({
      to: ["[redacted]", "[redacted]"],
      from: "[redacted]",
      Reply_To: "[redacted]",
      customer_email: "[redacted]",
      customer_phone: "[redacted]",
      contact: "[redacted]",
      vpa: "[redacted]",
      IP: "[redacted]",
      user_agent: "[redacted]",
      eventType: "email.bounced",
    });
  });
});
