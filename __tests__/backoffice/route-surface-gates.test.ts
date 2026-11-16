/**
 * @jest-environment node
 */

/**
 * Admin routes gated on the back-office permission matrix: each asks for its
 * surface, and a role the matrix refuses gets 403 before any read or write.
 */

import { NextRequest } from "next/server";
import {
  hasBackofficePermission,
  type BackofficeSurface,
} from "../../lib/auth/backoffice-permissions";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/api/after-safe", () => ({ scheduleAfter: jest.fn() }));
jest.mock("../../lib/observability/throttled-capture", () => ({
  captureThrottled: jest.fn(),
}));

const mockViewer: { role: "ADMIN" | "STAFF" | "CONSULTANT" } = {
  role: "ADMIN",
};
const mockGate = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async (surface: BackofficeSurface) => {
    mockGate(surface);
    return jest
      .requireActual<typeof import("../../lib/auth/backoffice-permissions")>(
        "../../lib/auth/backoffice-permissions",
      )
      .hasBackofficePermission(mockViewer.role, surface)
      ? { session: { user: { id: "op-1", role: mockViewer.role } } }
      : {
          error: jest
            .requireActual<typeof import("next/server")>("next/server")
            .NextResponse.json({ code: "FORBIDDEN" }, { status: 403 }),
        };
  },
}));

// Every model answers an empty read and every write succeeds, so only the gate decides the status.
const mockWrite = jest.fn(async () => ({ count: 1 }));
jest.mock("../../lib/prisma", () => {
  const model = {
    count: async () => 0,
    findMany: async () => [],
    findUnique: async () => null,
    aggregate: async () => ({ _sum: {}, _count: 0 }),
    groupBy: async () => [],
    updateMany: () => mockWrite(),
    create: async () => ({ id: "ops-row" }),
  };
  const db: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === "$transaction"
          ? (run: (tx: unknown) => Promise<unknown>) => run(db)
          : model,
    },
  );
  return { __esModule: true, default: db };
});
jest.mock("../../lib/trials/pricing-config", () => ({
  PRICING_CONFIG_ID: "singleton",
  getMinTrialPriceInPaise: async () => 0,
}));
jest.mock("../../lib/data/admin-stats", () => ({
  getAdminStats: async () => ({}),
}));
jest.mock("../../lib/maintenance", () => ({
  getMaintenanceState: async () => ({ phase: "OFF", bypassSecret: null }),
  setMaintenanceState: jest.fn(),
}));
jest.mock("../../lib/maintenance-edge", () => ({
  signMaintenanceBypassCookie: async () => "signed",
}));
jest.mock("../../lib/betterstack", () => ({
  createIncident: jest.fn(),
  resolveIncident: jest.fn(),
}));
jest.mock("../../actions/maintenance/drain-sessions", () => ({
  drainActiveSessions: jest.fn(),
  unfreezeChannelsAfterMaintenance: jest.fn(),
}));
jest.mock("../../actions/maintenance/pause-discount-codes", () => ({
  pauseDiscountCodes: jest.fn(),
}));
jest.mock("../../actions/maintenance/post-recovery", () => ({
  runPostRecovery: jest.fn(),
}));
jest.mock("../../lib/data/staff-appointments", () => ({
  getStaffAppointments: async () => ({ appointments: [] }),
}));
jest.mock("../../lib/data/booking-history", () => ({
  getBookingTimeline: async (id: string) => ({
    appointmentId: id,
    entries: [],
    truncated: false,
  }),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  participantReadLimiter: {},
}));
jest.mock("../../lib/storage/private-finance-object", () => ({
  privateFinanceObjectExists: async () => false,
  createPrivateFinanceSignedUrl: jest.fn(),
}));

import { GET as statsGet } from "../../app/api/admin/stats/route";
import {
  GET as trialPricingGet,
  PATCH as trialPricingPatch,
} from "../../app/api/admin/trial-pricing/route";
import { GET as cancellationsGet } from "../../app/api/admin/analytics/cancellations/route";
import { GET as maintenanceGet } from "../../app/api/admin/maintenance/route";
import { GET as preflightGet } from "../../app/api/admin/maintenance/preflight/route";
import { GET as metricsGet } from "../../app/api/staff/metrics/route";
import { GET as staffAppointmentsGet } from "../../app/api/staff/appointments/route";
import { GET as staffTimelineGet } from "../../app/api/staff/appointments/[appointmentId]/timeline/route";
import { GET as needsHumanGet } from "../../app/api/admin/sessions/needs-human/route";
import { GET as paymentsGet } from "../../app/api/admin/payments/route";
import { GET as paymentGet } from "../../app/api/admin/payments/[paymentId]/route";
import { GET as refundsGet } from "../../app/api/admin/refunds/route";
import { GET as disputesGet } from "../../app/api/admin/disputes/route";
import { GET as disputeGet } from "../../app/api/admin/disputes/[disputeId]/route";
import { GET as subscriptionsGet } from "../../app/api/admin/subscriptions/route";
import { GET as tdsReturnGet } from "../../app/api/admin/compliance/tds-return/route";
import { GET as gstRegisterGet } from "../../app/api/admin/compliance/gst-register/route";
import { POST as erasureProcess } from "../../app/api/admin/erasure-requests/[id]/process/route";
import { POST as erasureReject } from "../../app/api/admin/erasure-requests/[id]/reject/route";
import { GET as settlementLinesGet } from "../../app/api/admin/settlements/lines/route";

const APPOINTMENT_ID = "3b0a1b7c-42cd-465e-8b4d-8dccba7f8820";

const floorPatch = () =>
  trialPricingPatch(
    new NextRequest("http://test/api/admin/trial-pricing", {
      method: "PATCH",
      body: JSON.stringify({
        minTrialPriceInPaise: 9_900,
        reason: "Raise the floor for launch",
      }),
    }),
    { params: Promise.resolve({}) },
  );

const get = (path: string) => new NextRequest(`http://test${path}`);
const idParams = <K extends string>(key: K) => ({
  params: Promise.resolve({ [key]: "row-1" } as Record<K, string>),
});

/** A permitted call reaches its read; a missing row or file answers 404 there. */
const routes: Array<
  [string, BackofficeSurface, () => Promise<Response>, number?]
> = [
  ["GET /api/admin/stats", "analytics.read", () => statsGet()],
  [
    "GET /api/admin/analytics/cancellations",
    "analytics.read",
    () =>
      cancellationsGet(
        new NextRequest("http://test/api/admin/analytics/cancellations"),
      ),
  ],
  ["GET /api/admin/trial-pricing", "trialPricing.manage", trialPricingGet],
  ["PATCH /api/admin/trial-pricing", "trialPricing.manage", floorPatch],
  ["GET /api/admin/maintenance", "maintenance.manage", maintenanceGet],
  ["GET /api/admin/maintenance/preflight", "maintenance.manage", preflightGet],
  ["GET /api/staff/metrics", "analytics.read", metricsGet],
  [
    "GET /api/staff/appointments",
    "appointments.manage",
    () =>
      staffAppointmentsGet(
        new NextRequest("http://test/api/staff/appointments"),
      ),
  ],
  [
    "GET /api/staff/appointments/[id]/timeline",
    "appointments.manage",
    () =>
      staffTimelineGet(
        new NextRequest(
          `http://test/api/staff/appointments/${APPOINTMENT_ID}/timeline`,
        ),
        { params: Promise.resolve({ appointmentId: APPOINTMENT_ID }) },
      ),
  ],
  [
    "GET /api/admin/sessions/needs-human",
    "classSeries.support",
    () =>
      needsHumanGet(
        new NextRequest("http://test/api/admin/sessions/needs-human"),
      ),
  ],
  [
    "GET /api/admin/payments",
    "payments.read",
    () => paymentsGet(get("/api/admin/payments")),
  ],
  [
    "GET /api/admin/payments/[id]",
    "payments.read",
    () => paymentGet(get("/api/admin/payments/row-1"), idParams("paymentId")),
    404,
  ],
  [
    "GET /api/admin/refunds",
    "refunds.read",
    () => refundsGet(get("/api/admin/refunds")),
  ],
  [
    "GET /api/admin/disputes",
    "disputes.read",
    () => disputesGet(get("/api/admin/disputes")),
  ],
  [
    "GET /api/admin/disputes/[id]",
    "disputes.read",
    () => disputeGet(get("/api/admin/disputes/row-1"), idParams("disputeId")),
    404,
  ],
  [
    "GET /api/admin/subscriptions",
    "subscriptions.read",
    () => subscriptionsGet(get("/api/admin/subscriptions")),
  ],
  [
    "GET /api/admin/compliance/tds-return",
    "tds.read",
    () =>
      tdsReturnGet(
        get("/api/admin/compliance/tds-return?financialYear=2026-27&quarter=2"),
      ),
    404,
  ],
  [
    "GET /api/admin/compliance/gst-register",
    "compliance.manage",
    () =>
      gstRegisterGet(get("/api/admin/compliance/gst-register?period=2026-10")),
    404,
  ],
  [
    "POST /api/admin/erasure-requests/[id]/process",
    "compliance.manage",
    () =>
      erasureProcess(
        new NextRequest(
          "http://test/api/admin/erasure-requests/row-1/process",
          {
            method: "POST",
          },
        ),
        idParams("id"),
      ),
    404,
  ],
  [
    "POST /api/admin/erasure-requests/[id]/reject",
    "compliance.manage",
    () =>
      erasureReject(
        new NextRequest("http://test/api/admin/erasure-requests/row-1/reject", {
          method: "POST",
          body: JSON.stringify({ reason: "Open dispute on the account" }),
        }),
        idParams("id"),
      ),
    404,
  ],
  [
    "GET /api/admin/settlements/lines",
    "payouts.read",
    () => settlementLinesGet(get("/api/admin/settlements/lines")),
  ],
];

const cases = routes.flatMap(([name, surface, call, ok = 200]) =>
  (["ADMIN", "STAFF", "CONSULTANT"] as const).map(
    (role) =>
      [
        name,
        role,
        surface,
        call,
        hasBackofficePermission(role, surface) ? ok : 403,
      ] as const,
  ),
);

beforeEach(() => jest.clearAllMocks());

it("puts the trial-price floor on an ADMIN-only key", () => {
  expect(hasBackofficePermission("ADMIN", "trialPricing.manage")).toBe(true);
  expect(hasBackofficePermission("STAFF", "trialPricing.manage")).toBe(false);
});

it.each(cases)(
  "%s as %s asks for %s and answers %i",
  async (_name, role, surface, call, status) => {
    mockViewer.role = role;
    const res = await call();
    expect(mockGate).toHaveBeenCalledWith(surface);
    expect(res.status).toBe(status);
  },
);

it("a refused trial-pricing PATCH never writes the floor", async () => {
  mockViewer.role = "STAFF";
  expect((await floorPatch()).status).toBe(403);
  expect(mockWrite).not.toHaveBeenCalled();
});
