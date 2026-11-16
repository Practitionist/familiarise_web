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

// Every model answers an empty read, so only the gate decides the status.
jest.mock("../../lib/prisma", () => {
  const model = {
    count: async () => 0,
    findMany: async () => [],
    aggregate: async () => ({ _sum: {}, _count: 0 }),
    groupBy: async () => [],
  };
  return {
    __esModule: true,
    default: new Proxy({}, { get: () => model }),
  };
});
const mockSetFloor = jest.fn(async (paise: number) => paise);
jest.mock("../../lib/trials/pricing-config", () => ({
  getMinTrialPriceInPaise: async () => 0,
  setMinTrialPriceInPaise: (paise: number) => mockSetFloor(paise),
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

import { GET as statsGet } from "../../app/api/admin/stats/route";
import {
  GET as trialPricingGet,
  PATCH as trialPricingPatch,
} from "../../app/api/admin/trial-pricing/route";
import { GET as cancellationsGet } from "../../app/api/admin/analytics/cancellations/route";
import { GET as maintenanceGet } from "../../app/api/admin/maintenance/route";
import { GET as preflightGet } from "../../app/api/admin/maintenance/preflight/route";

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
  [
    "PATCH /api/admin/trial-pricing",
    "trialPricing.manage",
    () =>
      trialPricingPatch(
        new Request("http://test/api/admin/trial-pricing", {
          method: "PATCH",
          body: JSON.stringify({ minTrialPriceInPaise: 9_900 }),
        }),
      ),
  ],
  ["GET /api/admin/maintenance", "maintenance.manage", maintenanceGet],
  ["GET /api/admin/maintenance/preflight", "maintenance.manage", preflightGet],
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
  await trialPricingPatch(
    new Request("http://test/api/admin/trial-pricing", {
      method: "PATCH",
      body: JSON.stringify({ minTrialPriceInPaise: 9_900 }),
    }),
  );
  expect(mockSetFloor).not.toHaveBeenCalled();
});
