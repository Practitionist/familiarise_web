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

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  // #1861 P4b — reconcile-payment-status wraps each row in Sentry.withScope
  // to tag it; the mock just runs the callback against a stub scope.
  withScope: jest.fn((callback: (scope: unknown) => unknown) =>
    callback({ setTag: jest.fn(), setTags: jest.fn() }),
  ),
  getCurrentScope: jest.fn(() => ({ setTag: jest.fn(), setTags: jest.fn() })),
  flush: jest.fn(async () => true),
}));
// reportSentryError and the shared loggers capture through @sentry/core; share the one mock.
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $executeRaw: jest.fn().mockResolvedValue(1),
    // The closed-order cohort's ids; empty unless a test says otherwise.
    $queryRaw: jest.fn().mockResolvedValue([]),
    payment: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // #1822 Q-4 — the unresolvable-row report is now deduped via a
    // SystemEvent correlationId lookup before it fires.
    systemEvent: {
      findMany: jest.fn().mockResolvedValue([]),
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
  MaintenanceUnavailableError: class MaintenanceUnavailableError extends Error {},
  MaintenanceActiveError: class MaintenanceActiveError extends Error {},
}));

const routeCapturedPayment = jest.fn();
jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  routeCapturedPayment: (...a: unknown[]) => routeCapturedPayment(...a),
}));

// #1757 — the orphan retire path is the abandoned-payments unit; pin the
// delegation, not the unit (it has its own suite).
const retireOrphanPendingPayment = jest.fn();
jest.mock("../../scripts/payments/cleanup-abandoned-payments", () => ({
  retireOrphanPendingPayment: (...a: unknown[]) =>
    retireOrphanPendingPayment(...a),
}));
const recordSystemEvent = jest.fn();
jest.mock("../../lib/enterprise/system-events", () => {
  return {
    recordSystemEvent: (...a: unknown[]) => recordSystemEvent(...a),
    recordSystemEventSafe: (...a: unknown[]) => recordSystemEvent(...a),
    recordSystemErrorSafe: (...a: unknown[]) => recordSystemEvent(...a),
  };
});

import { reconcilePaymentStatus } from "../../scripts/payments/reconcile-payment-status";
import type { NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "../../lib/prisma";
import { getCleanupJobHandlers } from "../../lib/cron/cleanup-registry";

const { POST } = getCleanupJobHandlers("reconcile-payment-status")!;

// The script reads Razorpay over plain `fetch`, so the pin drives that.
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** Razorpay answers 400 BAD_REQUEST_ERROR for an order id it has no record of. */
function razorpayUnknownId() {
  mockFetch.mockResolvedValue({
    ok: false,
    status: 400,
    json: async () => ({
      error: {
        code: "BAD_REQUEST_ERROR",
        description: "The id provided does not exist",
      },
    }),
  });
}

function razorpayCaptured(capture: Record<string, unknown>) {
  mockFetch
    .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "paid" }) })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [{ status: "captured", ...capture }] }),
    });
}

function setRazorpayEnv() {
  process.env.RAZORPAY_KEY_ID = "rzp_test_x";
  process.env.RAZORPAY_SECRET = "secret_x";
}
const mockCaptureMessage = Sentry.captureMessage as jest.Mock;

const SECRET = "test-cron-secret";

function request(): NextRequest {
  const headers = new Headers({ authorization: `Bearer ${SECRET}` });
  return {
    headers,
    nextUrl: { searchParams: new URLSearchParams() },
  } as unknown as NextRequest;
}

const pendingRow = {
  id: "pay-1",
  paymentGateway: "RAZORPAY",
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
    setRazorpayEnv();
    // The window query answers with the row; the orphan-cohort query is empty.
    (prisma.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([pendingRow])
      .mockResolvedValueOnce([]);
  });

  it("counts an unknown order id as unresolvable and answers 207", async () => {
    razorpayUnknownId();

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
    razorpayUnknownId();
    // `Once`, not a persistent override — the mock is a module-level
    // singleton shared across every test in this file, and a persistent
    // stub here would leak into later describe blocks that expect the
    // default "nothing reported yet" behaviour.
    (prisma.systemEvent.findMany as unknown as jest.Mock).mockResolvedValueOnce(
      [{ context: { ids: ["pay-1"] } }],
    );

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(207);
    expect(body.unresolvableCount).toBe(1);
    expect(recordSystemEvent).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(prisma.systemEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          category: "STANDING_FINDING",
          correlationId: {
            startsWith: "standing:reconcile-payment-status:unresolvable:",
          },
          createdAt: { gte: expect.any(Date) },
        },
      }),
    );
  });

  it("reports again when the id set gains an id not reported before", async () => {
    razorpayUnknownId();
    (prisma.systemEvent.findMany as unknown as jest.Mock).mockResolvedValueOnce(
      [{ context: { ids: ["pay-other"] } }],
    );

    await POST(request());

    expect(recordSystemEvent).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  // #1822 — replay: run 1's lookup fails (still reports, still 207); run 2
  // finds run 1's recorded correlationId and stays quiet.
  it("reports despite a failed lookup, then suppresses the replay", async () => {
    razorpayUnknownId();
    const recorded = new Set<string>();
    recordSystemEvent.mockImplementationOnce(
      async (e: { context: { ids: string[] } }) => {
        e.context.ids.forEach((id) => recorded.add(id));
      },
    );
    (prisma.systemEvent.findMany as unknown as jest.Mock)
      .mockRejectedValueOnce(new Error("system_events unavailable"))
      .mockImplementationOnce(async () => [
        { context: { ids: [...recorded] } },
      ]);

    expect((await POST(request())).status).toBe(207);
    (prisma.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([pendingRow])
      .mockResolvedValueOnce([]);
    expect((await POST(request())).status).toBe(207);

    expect(recordSystemEvent).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps a gateway that cannot be reached as a run failure — 500", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNRESET"));

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
    ...pendingRow,
    id: "pay-old",
    createdAt: new Date(Date.now() - 10 * DAY),
  };
  const youngRow = {
    ...pendingRow,
    id: "pay-young",
    createdAt: new Date(Date.now() - 1 * DAY),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
    setRazorpayEnv();
    razorpayUnknownId();
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
    // The order the gateway was asked about rides along, so a row re-minted since is not retired.
    expect(retireOrphanPendingPayment).toHaveBeenCalledWith(
      "pay-old",
      pendingRow.paymentIntent,
    );
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
            category: "STANDING_FINDING",
            correlationId: expect.stringContaining(
              "standing:reconcile-payment-status:unresolvable:",
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
});

describe("reconcile-payment-status — SUCCEEDED routes through routeCapturedPayment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
    setRazorpayEnv();
    routeCapturedPayment.mockResolvedValue(undefined);
  });

  it("routes a captured payment with booking notes through routeCapturedPayment instead of direct status stamp", async () => {
    const bookingRow = {
      ...pendingRow,
      id: "pay-ok",
      paymentIntent: "order_1905",
      appointmentId: "appt-1905",
      appointment: { id: "appt-1905", slotsOfAppointment: [] },
    };
    (prisma.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([bookingRow])
      .mockResolvedValueOnce([]);
    razorpayCaptured({
      id: "pay_1905",
      amount: 50000,
      notes: { appointmentId: "appt-1905", consultantProfileId: "cp-1" },
    });

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(207);
    expect(body.reconciledCount).toBe(1);
    expect(routeCapturedPayment).toHaveBeenCalledWith({
      orderId: "order_1905",
      gatewayPaymentId: "pay_1905",
      notes: { appointmentId: "appt-1905", consultantProfileId: "cp-1" },
      amountPaise: 50000,
    });
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to stamp SUCCEEDED and records PAYMENT_RECONCILE_MISSING_BOOKING_CONTEXT when a booking lacks appointment and notes", async () => {
    const orphanRow = {
      ...pendingRow,
      id: "pay-no-ctx",
      paymentIntent: "order_no_ctx",
      appointmentId: null,
      appointment: null,
    };
    (prisma.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([orphanRow])
      .mockResolvedValueOnce([]);
    razorpayCaptured({ id: "pay_no_ctx", amount: 50000, notes: {} });

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.reconciledCount).toBe(0);
    expect(routeCapturedPayment).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(recordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "PAYMENT",
        message: expect.stringContaining(
          "PAYMENT_RECONCILE_MISSING_BOOKING_CONTEXT:",
        ),
      }),
    );
  });
});

// The rail comes from the row and the order, and only an answer naming the id means "unknown order".
describe("reconcile-payment-status — rows decide, and a bare 400 is not an unknown order", () => {
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
    setRazorpayEnv();
  });

  it("never retires a 10-day-old PENDING row on a 400 that does not name the id", async () => {
    (prisma.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          ...pendingRow,
          id: "pay-old",
          createdAt: new Date(Date.now() - 10 * DAY),
        },
      ]);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "Request failed. Please try after sometime.",
        },
      }),
    });

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.errors[0]).toContain("pay-old");
    expect(body.retiredCount).toBe(0);
    expect(body.unresolvableCount).toBe(0);
    expect(retireOrphanPendingPayment).not.toHaveBeenCalled();
  });

  it("drives an overage side payment whose captured payment carries no notes, with the order's notes", async () => {
    (prisma.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([
        {
          ...pendingRow,
          id: "pay-side",
          paymentIntent: "order_side",
          parentPaymentId: "pay-parent",
        },
      ])
      .mockResolvedValueOnce([]);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "paid",
          notes: { type: "overage_member" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        // Razorpay answers an empty notes map as an array.
        json: async () => ({
          items: [
            { status: "captured", id: "pay_side_1", amount: 12950, notes: [] },
          ],
        }),
      });

    const res = await POST(request());

    expect(res.status).toBe(207);
    expect(routeCapturedPayment).toHaveBeenCalledWith({
      orderId: "order_side",
      gatewayPaymentId: "pay_side_1",
      notes: { type: "overage_member" },
      amountPaise: 12950,
    });
  });
});

// A gateway no sweep can read is stamped out of the cohort once; pre-mint rows are never reconciled.
describe("reconcile-payment-status — permanent rows and pre-mint rows", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const cardRow = {
    ...pendingRow,
    id: "pay-card",
    paymentGateway: "CARD",
    createdAt: new Date(Date.now() - 30 * DAY),
  };
  const findMany = prisma.payment.findMany as jest.Mock;
  const updateMany = prisma.payment.updateMany as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
    setRazorpayEnv();
    updateMany.mockResolvedValue({ count: 1 });
  });

  it("dead-letters an unsupported gateway by CAS, reports once, and keeps success with a young unknown id", async () => {
    razorpayUnknownId();
    findMany
      .mockResolvedValueOnce([pendingRow])
      .mockResolvedValueOnce([cardRow]);

    const res = await POST(request());
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.deadLettered).toBe(1);
    expect(body.unresolvableCount).toBe(1);
    expect(retireOrphanPendingPayment).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "pay-card",
        paymentStatus: "PENDING",
      }),
      data: {
        description: expect.stringMatching(/^REQUIRES_MANUAL_RECOVERY: /),
      },
    });
    const reports = recordSystemEvent.mock.calls.filter(([e]) =>
      String(e.summary ?? "").includes("unsupported gateway"),
    );
    expect(reports).toEqual([
      [expect.objectContaining({ context: { paymentIds: ["pay-card"] } })],
    ]);
  });

  it("still fails the run on a transient gateway error beside a dead-lettered row", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNRESET"));
    findMany
      .mockResolvedValueOnce([pendingRow])
      .mockResolvedValueOnce([cardRow]);

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.deadLettered).toBe(1);
    expect(body.errors).toEqual([expect.stringContaining("pay-1")]);
  });

  it("excludes stamped and pre-mint rows from both cohorts, so neither is touched again", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await POST(request());

    for (const [query] of findMany.mock.calls) {
      expect(query.where.AND).toEqual(
        expect.arrayContaining([
          {
            NOT: expect.arrayContaining([
              { paymentIntent: { startsWith: "premint_" } },
            ]),
          },
          {
            OR: [
              { description: null },
              {
                NOT: {
                  description: { startsWith: "REQUIRES_MANUAL_RECOVERY:" },
                },
              },
            ],
          },
        ]),
      );
    }
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("payment polling progress after interrupted runs", () => {
  it("rotates unchanged pending records so all 25 are polled in three bounded runs", async () => {
    setRazorpayEnv();
    const rows = Array.from({ length: 25 }, (_, i) => ({
      ...pendingRow,
      id: `p_${String(i).padStart(2, "0")}`,
      paymentIntent: `order_${i}`,
      lastReconciledAt: null as Date | null,
    }));
    const findMany = prisma.payment.findMany as jest.Mock;
    findMany
      .mockReset()
      .mockImplementation(
        async (q: { where: { paymentGateway?: string }; take: number }) =>
          q.where.paymentGateway
            ? [...rows]
                .sort(
                  (a, b) =>
                    (a.lastReconciledAt?.getTime() ?? 0) -
                      (b.lastReconciledAt?.getTime() ?? 0) ||
                    (a.id < b.id ? -1 : 1),
                )
                .slice(0, q.take)
            : [],
      );
    const stamp = prisma.$executeRaw as jest.Mock;
    stamp
      .mockClear()
      .mockImplementation(async (_sql: TemplateStringsArray, id: string) => {
        const row = rows.find((r) => r.id === id);
        if (row) row.lastReconciledAt = new Date();
        return 1;
      });
    mockFetch.mockReset().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "created" }),
    });
    for (let i = 0; i < 3; i++) await reconcilePaymentStatus({ limit: 10 });
    expect(new Set(mockFetch.mock.calls.map(([url]) => url)).size).toBe(25);
    expect(stamp).toHaveBeenCalledTimes(30);
    stamp.mockResolvedValue(1);
  });

  it("does not poll or rotate candidates when the execution budget was already exhausted", async () => {
    (prisma.payment.findMany as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce([pendingRow])
      .mockResolvedValueOnce([]);
    mockFetch.mockClear();
    (prisma.$executeRaw as jest.Mock).mockClear();
    await reconcilePaymentStatus({ startedAt: Date.now() - 20_000 });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("does not start a gateway read with under 3 s of budget left, leaving the row unstamped", async () => {
    setRazorpayEnv();
    (prisma.payment.findMany as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce([pendingRow])
      .mockResolvedValueOnce([]);
    mockFetch.mockReset().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "created" }),
    });
    (prisma.$executeRaw as jest.Mock).mockClear();
    const result = await reconcilePaymentStatus({
      startedAt: Date.now() - 14_000,
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(result.totalProcessed).toBe(0);
  });

  it("rotates attempted timeouts and ordinary gateway errors", async () => {
    setRazorpayEnv();
    const timedOut = {
      ...pendingRow,
      id: "pay-a-timeout",
      paymentIntent: "o1",
    };
    const failed = { ...pendingRow, id: "pay-b-500", paymentIntent: "o2" };
    (prisma.payment.findMany as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce([timedOut, failed])
      .mockResolvedValueOnce([]);
    mockFetch
      .mockReset()
      .mockRejectedValueOnce(
        Object.assign(new Error("The operation was aborted due to timeout"), {
          name: "TimeoutError",
        }),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: { description: "server error" } }),
      });
    const stamp = (prisma.$executeRaw as jest.Mock).mockClear();
    const result = await reconcilePaymentStatus();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(stamp.mock.calls.map((c) => c[1])).toEqual([
      "pay-a-timeout",
      "pay-b-500",
    ]);
    expect(result.errors).toEqual([
      expect.stringContaining("pay-a-timeout"),
      expect.stringContaining("pay-b-500"),
    ]);
  });

  it("reaches later payments when each attempted lookup consumes the entire run budget", async () => {
    setRazorpayEnv();
    let now = Date.now();
    const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
    const rows = Array.from({ length: 3 }, (_, i) => ({
      ...pendingRow,
      id: `slow-${i}`,
      paymentIntent: `order_slow_${i}`,
      lastReconciledAt: null as Date | null,
    }));
    const findMany = prisma.payment.findMany as jest.Mock;
    const stamp = prisma.$executeRaw as jest.Mock;
    try {
      findMany
        .mockReset()
        .mockImplementation(
          async (query: {
            where: { paymentGateway?: string };
            take: number;
          }) =>
            query.where.paymentGateway
              ? [...rows]
                  .sort(
                    (a, b) =>
                      (a.lastReconciledAt?.getTime() ?? 0) -
                        (b.lastReconciledAt?.getTime() ?? 0) ||
                      (a.id < b.id ? -1 : 1),
                  )
                  .slice(0, query.take)
              : [],
        );
      stamp
        .mockClear()
        .mockImplementation(async (_sql: TemplateStringsArray, id: string) => {
          const row = rows.find((candidate) => candidate.id === id);
          if (row) row.lastReconciledAt = new Date(now);
          return 1;
        });
      mockFetch.mockReset().mockImplementation(async () => {
        now += 16_000;
        throw Object.assign(new Error("gateway lookup timed out"), {
          name: "TimeoutError",
        });
      });
      for (let run = 0; run < 3; run++) {
        const result = await reconcilePaymentStatus({ limit: 1 });
        expect(result.success).toBe(false);
        expect(result.totalProcessed).toBe(1);
        now += 15 * 60 * 1000;
      }
      expect(new Set(mockFetch.mock.calls.map(([url]) => url)).size).toBe(3);
      expect(stamp.mock.calls.map((call) => call[1])).toEqual([
        "slow-0",
        "slow-1",
        "slow-2",
      ]);
    } finally {
      clock.mockRestore();
      stamp.mockReset().mockResolvedValue(1);
    }
  });
});
