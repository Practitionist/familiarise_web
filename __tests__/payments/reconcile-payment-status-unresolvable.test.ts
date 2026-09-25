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
    // #1822 Q-4 — the unresolvable-row report is now deduped via a
    // SystemEvent correlationId lookup before it fires.
    systemEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "event-1" }),
    },
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  LONG_JOB_TTL_MS: 1,
  CronLockHeldError: class CronLockHeldError extends Error {},
  // #1822 Q-2 — cleanup-route.ts now checks `instanceof CronLockUnavailableError`
  // too; without this export the check throws on `undefined`.
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: jest.fn(),
  MaintenanceActiveError: class MaintenanceActiveError extends Error {},
}));

jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  routeCapturedPayment: jest.fn(),
}));

// #1757 — the orphan retire path is the abandoned-payments unit; pin the
// delegation, not the unit (it has its own suite).
const retireOrphanPendingPayment = jest.fn();
jest.mock("../../scripts/payments/cleanup-abandoned-payments", () => ({
  retireOrphanPendingPayment: (...a: unknown[]) =>
    retireOrphanPendingPayment(...a),
}));
const recordSystemEvent = jest.fn();
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: (...a: unknown[]) => recordSystemEvent(...a),
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
  // Relative, never fixed: the row must sit inside the 7d reconcile window
  // AND below the 7d orphan cutoff (report path, not retire path). A fixed
  // date rotted past both cutoffs on 2026-09-21 and flipped this test to the
  // retire path, whose mocked helper returns undefined (500, not 207).
  createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  user: null,
  appointment: null,
};

describe("reconcile-payment-status — an unknown gateway id (#1708)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    // The window query answers with the row; the orphan-cohort query is empty.
    (prisma.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([pendingStripeRow])
      .mockResolvedValueOnce([]);
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

  // #1822 Q-4 — the same stuck row set used to re-mint a Sentry event on
  // every tick until it resolved or aged into #1757's retire path; that is
  // what turned a second-largest issue (1,147 events, same 4 rows) into a
  // near-budget-sized cost. Reported at most once per 24h per distinct id set.
  it("does not re-report the same unresolvable id set within 24h", async () => {
    mockRetrieve.mockRejectedValue(
      Object.assign(new Error("No such payment_intent"), {
        code: "resource_missing",
        statusCode: 404,
      }),
    );
    // `Once`, not a persistent override — the mock is a module-level
    // singleton shared across every test in this file, and a persistent
    // stub here would leak into later describe blocks that expect the
    // default "nothing reported yet" behaviour.
    (
      prisma.systemEvent.findFirst as unknown as jest.Mock
    ).mockResolvedValueOnce({
      id: "already-reported",
    });

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(207);
    expect(body.unresolvableCount).toBe(1);
    expect(recordSystemEvent).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(prisma.systemEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          correlationId: expect.stringMatching(
            /^reconcile-payment-status:unresolvable:[0-9a-f]{16}$/,
          ),
          createdAt: { gte: expect.any(Date) },
        },
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

/**
 * #1757 — a PENDING row nothing can claim (no `expiresAt`, no tentative hold,
 * so abandoned-payments never selects it) was re-reported every five minutes
 * for the same ids (FAMILIARISE_WEB-4P). Past the orphan age an unknown-id
 * answer now retires it through the abandoned-payments unit and reports once;
 * a younger one keeps the report-only behaviour.
 */
describe("reconcile-payment-status — orphan PENDING rows are retired (#1757)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const oldRow = {
    ...pendingStripeRow,
    id: "pay-old",
    createdAt: new Date(Date.now() - 10 * DAY),
  };
  const youngRow = {
    ...pendingStripeRow,
    id: "pay-young",
    createdAt: new Date(Date.now() - 1 * DAY),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    delete process.env.RECONCILE_ORPHAN_PENDING_MAX_AGE_MS;
    mockRetrieve.mockRejectedValue(
      Object.assign(new Error("No such payment_intent"), {
        code: "resource_missing",
        statusCode: 404,
      }),
    );
    retireOrphanPendingPayment.mockResolvedValue({
      outcome: "retired",
      errors: [],
    });
  });

  it("10-day-old → retired via the helper + SystemEvent; 1-day-old → reported only", async () => {
    (prisma.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([youngRow])
      .mockResolvedValueOnce([oldRow]);

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(207);
    expect(body.success).toBe(true);
    expect(body.retiredCount).toBe(1);
    expect(body.unresolvableCount).toBe(1);
    expect(retireOrphanPendingPayment).toHaveBeenCalledTimes(1);
    expect(retireOrphanPendingPayment).toHaveBeenCalledWith("pay-old");
    // The row is never written directly here — the helper owns the CAS.
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    // #1822 Q-4 — the retire helper's own SystemEvent, plus a second one this
    // run writes to dedupe the unresolvable-row report (see below).
    expect(recordSystemEvent).toHaveBeenCalledTimes(2);
    expect(recordSystemEvent.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            category: "PAYMENT",
            message: expect.stringContaining("PAYMENT_ORPHAN_RETIRED: pay-old"),
          }),
        ],
        [
          expect.objectContaining({
            category: "CRON",
            correlationId: expect.stringContaining(
              "reconcile-payment-status:unresolvable:",
            ),
          }),
        ],
      ]),
    );
    // One Sentry message for the retired ids and one for the reported ids.
    const messages = mockCaptureMessage.mock.calls.map(([m]) => String(m));
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("retired 1 orphan"),
        expect.stringContaining("1 pending payments"),
      ]),
    );
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
  });

  it("the orphan age is read from RECONCILE_ORPHAN_PENDING_MAX_AGE_MS", async () => {
    process.env.RECONCILE_ORPHAN_PENDING_MAX_AGE_MS = String(
      12 * 60 * 60 * 1000,
    );
    (prisma.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([youngRow])
      .mockResolvedValueOnce([]);

    const res = await POST(request());
    const body = await res.json();

    expect(body.retiredCount).toBe(1);
    expect(body.unresolvableCount).toBe(0);
    expect(retireOrphanPendingPayment).toHaveBeenCalledWith("pay-young");
  });
});
