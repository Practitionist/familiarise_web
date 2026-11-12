/**
 * @jest-environment node
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/api/after-safe", () => ({
  scheduleAfter: (fn: () => unknown) => fn(),
}));
jest.mock("../../lib/auth/step-up", () => ({
  requireFreshSession: () => null,
}));
jest.mock("../../lib/backoffice/money-limit", () => ({
  assertMoneyOpsBudget: jest.fn(),
}));
const mockLocks = new Set<string>();
const mockReleases = jest.fn();
jest.mock("../../lib/redis", () => ({
  acquireLock: async (key: string) => {
    if (mockLocks.has(key)) return null;
    mockLocks.add(key);
    return "token";
  },
  releaseLock: async (key: string) => {
    mockReleases(key);
    mockLocks.delete(key);
  },
}));

const mockViewer = { id: "staff-1", role: "STAFF" as "STAFF" | "ADMIN" };
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async (surface: BackofficeSurface) =>
    jest
      .requireActual<typeof import("../../lib/auth/backoffice-permissions")>(
        "../../lib/auth/backoffice-permissions",
      )
      .hasBackofficePermission(mockViewer.role, surface)
      ? { session: { user: { ...mockViewer } } }
      : {
          error: jest
            .requireActual<typeof import("next/server")>("next/server")
            .NextResponse.json({ code: "FORBIDDEN" }, { status: 403 }),
        },
}));

const mockMaintenance = { phase: "OFF", unreadable: false as boolean };
jest.mock("../../lib/maintenance-edge", () => ({
  getMaintenanceState: async () => ({
    phase: mockMaintenance.phase,
    reason: null,
    estimatedEnd: null,
    bypassSecret: null,
    ...(mockMaintenance.unreadable ? { unreadable: true } : {}),
  }),
}));

const mockPerformCaseAction = jest.fn();
const mockPerformCaseActionTx = jest.fn();
jest.mock("../../lib/support/case-actions", () => {
  const { z } = jest.requireActual<typeof import("zod")>("zod");
  class CaseActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status = 409,
    ) {
      super(message);
    }
  }
  const base = {
    clientActionId: z.string(),
    expectedUpdatedAt: z.string(),
    reason: z.string(),
  };
  return {
    CaseActionError,
    assertIndependentReviewer: async () => undefined,
    priceCaseRefundReview: async () => 100_000,
    performCaseAction: (...args: unknown[]) => mockPerformCaseAction(...args),
    performCaseActionTx: (...args: unknown[]) =>
      mockPerformCaseActionTx(...args),
    ApplyHoldSchema: z.object({
      ...base,
      action: z.literal("APPLY_HOLD"),
      paymentId: z.string(),
    }),
    ReleaseHoldSchema: z.object({
      ...base,
      action: z.literal("RELEASE_HOLD"),
      holdId: z.string(),
    }),
    VoidRecommendationSchema: z.object({
      ...base,
      action: z.literal("VOID_RECOMMENDATION"),
      recommendationId: z.string(),
    }),
  };
});

const mockAuditRows: Record<string, unknown>[] = [];
const mockOpsRows: { after: unknown }[] = [];
jest.mock("../../lib/prisma", () => {
  const db = {
    user: { count: async () => 2 },
    supportCase: {
      findFirst: async () => ({
        id: "case-1",
        ownershipScope: "PERSONAL",
        submitterUserId: "customer",
        requesterUserId: "customer",
        organizationId: null,
        appealOfDecisionId: null,
        appealOfModerationActionId: null,
      }),
    },
    appointment: {
      findUnique: async () => ({
        consultationId: "consultation-1",
        subscriptionId: null,
        webinarId: null,
        classId: null,
      }),
    },
    supportFinancialRecommendation: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    consultantEarnings: {
      findMany: async () => [
        { consultantSharePaise: 80_000, refundedShareAmount: 20_000 },
      ],
    },
    organizationEarnings: {
      findMany: async () => [{ orgSharePaise: 30_000, refundedAmountPaise: 0 }],
    },
    opsActionLog: {
      findMany: async () => mockOpsRows,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        mockAuditRows.push(data);
        return { id: "log" };
      },
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { __esModule: true, default: db };
});

jest.mock("../../lib/booking/cancellation-scope", () => ({
  resolveBookingRefundContext: async () => ({
    paidPayment: { id: "pay-1" },
  }),
}));

const mockCancel = jest.fn();
jest.mock("../../app/api/appointments/[appointmentId]/cancel/route", () => ({
  POST: (...args: unknown[]) => mockCancel(...args),
}));

import { NextRequest, NextResponse } from "next/server";
import type { BackofficeSurface } from "../../lib/auth/backoffice-permissions";
import { assertMoneyDoorsOpen } from "../../lib/backoffice/maintenance-gate";
import { platformCancelGrant } from "../../lib/booking/platform-cancel";
import { reviewSupportRefundDoor } from "../../lib/support/refund-door";
import { applySupportHoldDoor } from "../../lib/support/case-doors";
import { POST as platformCancel } from "../../app/api/staff/appointments/[appointmentId]/cancel/route";

const APPT = "8b2f6c1e-1d2a-4f3b-9c4d-5e6f7a8b9c0d";

function post(
  door: (
    req: NextRequest,
    ctx: { params: Promise<unknown> },
  ) => Promise<Response>,
  body: object,
  params: Record<string, string>,
) {
  return door(
    new NextRequest("https://x.test/api", {
      method: "POST",
      body: JSON.stringify({ reason: "Customer was not served", ...body }),
    }),
    { params: Promise.resolve(params) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockViewer.id = "staff-1";
  mockViewer.role = "STAFF";
  mockMaintenance.phase = "OFF";
  mockMaintenance.unreadable = false;
  mockAuditRows.length = 0;
  mockOpsRows.length = 0;
  mockLocks.clear();
  mockPerformCaseAction.mockResolvedValue({
    paymentId: "pay-1",
    amountPaise: 100_000,
    movedPaise: 100_000,
    refund: { refundId: "refund-1", rail: "GATEWAY", status: "PENDING" },
  });
  mockCancel.mockResolvedValue(
    NextResponse.json({ success: true, refund: { status: "PENDING" } }),
  );
});

describe("maintenance gate", () => {
  it.each([
    ["DEGRADED", false, "MAINTENANCE"],
    ["OFFLINE", false, "MAINTENANCE"],
    ["OFF", true, "MAINTENANCE_UNKNOWN"],
  ])(
    "refuses money doors in %s (unreadable=%s)",
    async (phase, unreadable, code) => {
      mockMaintenance.phase = phase;
      mockMaintenance.unreadable = unreadable;
      await expect(assertMoneyDoorsOpen()).rejects.toMatchObject({
        code,
        httpStatus: 503,
      });
    },
  );

  it("refuses a support refund approval during maintenance, before any money moves", async () => {
    mockMaintenance.phase = "DEGRADED";
    const response = await post(
      reviewSupportRefundDoor,
      {
        action: "REVIEW_REFUND",
        clientActionId: "r-1",
        expectedUpdatedAt: "2026-10-20T10:00:00.000Z",
        recommendationId: "rec-1",
        approve: true,
        expectedRefundablePaise: 1_000_000,
      },
      { caseId: "case-1" },
    );
    expect(response.status).toBe(503);
    expect(mockPerformCaseAction).not.toHaveBeenCalled();
    expect(mockAuditRows).toContainEqual(
      expect.objectContaining({
        action: "support.refund.review",
        after: { status: "FAILED", code: "MAINTENANCE" },
      }),
    );
  });

  it("refuses a support payout hold when maintenance status is unreadable", async () => {
    mockMaintenance.unreadable = true;
    const response = await post(
      applySupportHoldDoor,
      {
        action: "APPLY_HOLD",
        clientActionId: "h-1",
        expectedUpdatedAt: "2026-10-20T10:00:00.000Z",
        paymentId: "pay-1",
      },
      { caseId: "case-1" },
    );
    expect(response.status).toBe(503);
    expect(mockPerformCaseActionTx).not.toHaveBeenCalled();
    expect(mockAuditRows).toHaveLength(0);
  });
});

describe("support refund door audit", () => {
  it("lets staff execute and writes the money into the ops-log row", async () => {
    const response = await post(
      reviewSupportRefundDoor,
      {
        action: "REVIEW_REFUND",
        clientActionId: "r-1",
        expectedUpdatedAt: "2026-10-20T10:00:00.000Z",
        recommendationId: "rec-1",
        approve: true,
        expectedRefundablePaise: 1_000_000,
      },
      { caseId: "case-1" },
    );
    expect(response.status).toBe(200);
    expect(mockAuditRows).toContainEqual(
      expect.objectContaining({
        actorUserId: "staff-1",
        surface: "supportRefunds.executeBounded",
        after: expect.objectContaining({
          status: "SUCCEEDED",
          paymentId: "pay-1",
          amountPaise: 100_000,
          movedPaise: 100_000,
          refundId: "refund-1",
          rail: "GATEWAY",
          refundStatus: "PENDING",
        }),
      }),
    );
  });

  it("keeps the staff lock to its TTL when the refund outcome is unknown", async () => {
    mockPerformCaseAction.mockRejectedValueOnce(new Error("socket hang up"));
    const response = await post(
      reviewSupportRefundDoor,
      {
        action: "REVIEW_REFUND",
        clientActionId: "r-1",
        expectedUpdatedAt: "2026-10-20T10:00:00.000Z",
        recommendationId: "rec-1",
        approve: true,
        expectedRefundablePaise: 1_000_000,
      },
      { caseId: "case-1" },
    );
    expect(response.status).toBe(500);
    expect(mockLocks.has("staff-refund:staff-1")).toBe(true);
    expect(mockReleases).not.toHaveBeenCalled();
  });
});

describe("support hold door audit", () => {
  const apply = () =>
    post(
      applySupportHoldDoor,
      {
        action: "APPLY_HOLD",
        clientActionId: "h-1",
        expectedUpdatedAt: "2026-10-20T10:00:00.000Z",
        paymentId: "pay-1",
      },
      { caseId: "case-1" },
    );

  it("records the held payee money, net of refunds, in the ops-log row", async () => {
    mockPerformCaseActionTx.mockResolvedValue({
      holdId: "hold-1",
      paymentId: "pay-1",
      replayed: false,
      consultantEarningIds: ["ce-1"],
      orgEarningIds: ["oe-1"],
      cancelledPayoutIds: [],
    });
    expect((await apply()).status).toBe(200);
    expect(mockAuditRows).toContainEqual(
      expect.objectContaining({
        action: "support.hold.apply",
        targetId: "pay-1",
        after: expect.objectContaining({
          caseId: "case-1",
          holdId: "hold-1",
          replayed: false,
          heldPaise: 90_000,
        }),
      }),
    );
  });

  it("records 0 for a replay that froze nothing", async () => {
    mockPerformCaseActionTx.mockResolvedValue({
      holdId: "hold-1",
      paymentId: "pay-1",
      replayed: true,
      consultantEarningIds: [],
      orgEarningIds: [],
      cancelledPayoutIds: [],
    });
    expect((await apply()).status).toBe(200);
    expect(mockAuditRows).toContainEqual(
      expect.objectContaining({
        after: expect.objectContaining({ replayed: true, heldPaise: 0 }),
      }),
    );
  });
});

describe("platform cancel door", () => {
  const cancel = (expectedRefundPaise: number) =>
    post(
      platformCancel,
      { cancellationReason: "OTHER", expectedRefundPaise },
      { appointmentId: APPT },
    );

  it("runs a staff cancel within the limit under a one-request grant, audited", async () => {
    const response = await cancel(400_000);
    expect(response.status).toBe(200);
    const [request] = mockCancel.mock.calls[0] as [NextRequest];
    expect(platformCancelGrant(request)).toMatchObject({
      opsActionId: expect.any(String),
    });
    expect(await request.json()).toMatchObject({
      reason: "OTHER",
      expectedRefundPaise: 400_000,
    });
    expect(mockAuditRows).toContainEqual(
      expect.objectContaining({
        action: "appointment.cancel.platform",
        surface: "appointments.cancelForPlatform",
        targetId: APPT,
        after: expect.objectContaining({
          status: "SUCCEEDED",
          movedPaise: 400_000,
          paymentIds: ["pay-1"],
          charges: [{ paymentId: "pay-1", newPaise: 400_000 }],
        }),
      }),
    );
  });

  it("refuses a staff cancel above the per-payment limit and leaves it to an admin", async () => {
    const refused = await cancel(600_000);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("ADMIN_REQUIRED");
    expect(mockCancel).not.toHaveBeenCalled();

    mockViewer.id = "admin-1";
    mockViewer.role = "ADMIN";
    expect((await cancel(600_000)).status).toBe(200);
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  it("counts the staff member's rolling 24-hour refunds", async () => {
    mockOpsRows.push({ after: { movedPaise: 4_800_000 } });
    const refused = await cancel(300_000);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("STAFF_DAILY_LIMIT");
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it("passes the participant route's refusal through", async () => {
    mockCancel.mockResolvedValueOnce(
      NextResponse.json(
        { error: "Quote changed", code: "REFUND_QUOTE_CHANGED" },
        { status: 409 },
      ),
    );
    const response = await cancel(100_000);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("REFUND_QUOTE_CHANGED");
    expect(mockLocks.size).toBe(0);
  });

  it("keeps the staff lock to its TTL when the cancel outcome is unknown", async () => {
    mockCancel.mockResolvedValueOnce(
      NextResponse.json({ error: "boom" }, { status: 500 }),
    );
    expect((await cancel(100_000)).status).toBe(500);
    expect(mockLocks.has("staff-refund:staff-1")).toBe(true);
    expect(mockReleases).not.toHaveBeenCalled();
  });

  it("serializes one staff member's refunds so parallel requests cannot each pass the rolling limit", async () => {
    mockLocks.add("staff-refund:staff-1");
    const busy = await cancel(100_000);
    expect(busy.status).toBe(409);
    expect((await busy.json()).code).toBe("STAFF_REFUND_IN_PROGRESS");
    expect(mockCancel).not.toHaveBeenCalled();

    mockLocks.clear();
    expect((await cancel(100_000)).status).toBe(200);
    expect(mockReleases).toHaveBeenCalledWith("staff-refund:staff-1");
    expect(mockLocks.size).toBe(0);
    expect((await cancel(600_000)).status).toBe(403);
    expect(mockLocks.size).toBe(0);
  });

  it("refuses during maintenance", async () => {
    mockMaintenance.phase = "DEGRADED";
    expect((await cancel(100_000)).status).toBe(503);
    expect(mockCancel).not.toHaveBeenCalled();
  });
});
