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

const routes: Array<[string, BackofficeSurface, () => Promise<Response>]> = [
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
];

const cases = routes.flatMap(([name, surface, call]) =>
  (["ADMIN", "STAFF", "CONSULTANT"] as const).map(
    (role) =>
      [
        name,
        role,
        surface,
        call,
        hasBackofficePermission(role, surface) ? 200 : 403,
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
