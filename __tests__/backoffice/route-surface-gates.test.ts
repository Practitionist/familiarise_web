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
    findFirst: async () => null,
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

jest.mock("../../lib/support/case-service", () => ({
  supportMonthlyComplianceReport: async () => ({}),
}));
jest.mock("../../lib/support/deflection", () => ({
  supportHealthMetrics: async () => ({}),
}));
jest.mock("../../lib/currency", () => ({
  getExchangeRateCacheInfo: () => ({ cachedAt: null, ageMs: null }),
  invalidateExchangeRateCache: jest.fn(),
  getExchangeRates: async () => ({ INR: 1 }),
}));
jest.mock("../../lib/newsletter/service", () => ({
  listSubscribers: async () => ({ subscribers: [], total: 0 }),
  exportSubscribersCsv: async () => "",
  listSendableSubscribers: async () => [],
  withLiveMarketingConsent: async () => [],
}));
jest.mock("../../lib/email", () => ({
  SENDERS: { newsletter: "news@test" },
  getResendClient: () => null,
}));
jest.mock("../../lib/email/suppression", () => ({
  findSuppressed: async () => new Set<string>(),
  normaliseEmail: (email: string) => email.toLowerCase(),
}));
jest.mock("../../lib/api/scope/list-documents", () => ({
  listDocumentsScoped: async () => ({ documents: [], total: 0 }),
}));
jest.mock("../../lib/moderation/review-context", () => ({
  readReviewReportSignals: async () => new Map(),
  readReviewReportContext: async () => null,
  readExclusionDropsBelowGate: async () => false,
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
import { GET as complianceReportGet } from "../../app/api/admin/support/compliance-report/route";
import { GET as supportHealthGet } from "../../app/api/admin/support/health/route";
import { GET as systemEventsGet } from "../../app/api/admin/system-events/route";
import {
  GET as exchangeRatesGet,
  POST as exchangeRatesPost,
} from "../../app/api/admin/exchange-rates/route";
import { GET as newsletterGet } from "../../app/api/admin/newsletter/route";
import { POST as broadcastPost } from "../../app/api/admin/newsletter/broadcast/route";
import { GET as organizationsGet } from "../../app/api/admin/organizations/route";
import { GET as documentsGet } from "../../app/api/admin/documents/route";
import { GET as usersGet } from "../../app/api/admin/users/route";
import { GET as verificationsGet } from "../../app/api/admin/verification/route";
import {
  GET as verificationGet,
  PATCH as verificationPatch,
} from "../../app/api/admin/verification/[verificationId]/route";
import { GET as feedbacksGet } from "../../app/api/staff/feedbacks/route";
import {
  GET as feedbackGet,
  PATCH as feedbackPatch,
} from "../../app/api/staff/feedbacks/[feedbackId]/route";
import { GET as reportsGet } from "../../app/api/staff/moderation/reports/route";
import {
  GET as reportGet,
  PATCH as reportPatch,
} from "../../app/api/staff/moderation/reports/[reportId]/route";
import { POST as reportAction } from "../../app/api/staff/moderation/reports/[reportId]/action/route";
import { POST as reportUnban } from "../../app/api/staff/moderation/reports/[reportId]/unban/route";
import { GET as reviewsGet } from "../../app/api/staff/moderation/reviews/route";
import { DELETE as reviewDelete } from "../../app/api/staff/moderation/reviews/[reviewId]/route";
import { GET as moderationStatsGet } from "../../app/api/staff/moderation/stats/route";

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
const send = (method: string, path: string, body: unknown) =>
  new NextRequest(`http://test${path}`, {
    method,
    body: JSON.stringify(body),
  });
const REASON = "Checked against the submitted documents";
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
  [
    "GET /api/admin/support/compliance-report",
    "compliance.manage",
    () => complianceReportGet(get("/api/admin/support/compliance-report")),
  ],
  [
    "GET /api/admin/support/health",
    "systemJobs.manage",
    () => supportHealthGet(get("/api/admin/support/health")),
  ],
  [
    "GET /api/admin/system-events",
    "systemJobs.manage",
    () => systemEventsGet(get("/api/admin/system-events")),
  ],
  ["GET /api/admin/exchange-rates", "systemJobs.manage", exchangeRatesGet],
  ["POST /api/admin/exchange-rates", "systemJobs.manage", exchangeRatesPost],
  [
    "GET /api/admin/newsletter",
    "newsletter.manage",
    () => newsletterGet(get("/api/admin/newsletter")),
  ],
  [
    "POST /api/admin/newsletter/broadcast (preview)",
    "newsletter.send",
    () =>
      broadcastPost(
        send("POST", "/api/admin/newsletter/broadcast", { mode: "preview" }),
      ),
  ],
  [
    "GET /api/admin/organizations",
    "organizations.manage",
    () => organizationsGet(get("/api/admin/organizations")),
  ],
  [
    "GET /api/admin/documents",
    "users.verify",
    () => documentsGet(get("/api/admin/documents")),
  ],
  [
    "GET /api/admin/users",
    "users.read",
    () => usersGet(get("/api/admin/users")),
  ],
  [
    "GET /api/admin/verification",
    "users.verify",
    () => verificationsGet(get("/api/admin/verification")),
  ],
  [
    "GET /api/admin/verification/[id]",
    "users.verify",
    () =>
      verificationGet(
        get("/api/admin/verification/row-1"),
        idParams("verificationId"),
      ),
    404,
  ],
  [
    "PATCH /api/admin/verification/[id]",
    "users.verify",
    () =>
      verificationPatch(
        send("PATCH", "/api/admin/verification/row-1", {
          status: "APPROVED",
          reason: REASON,
        }),
        idParams("verificationId"),
      ),
    404,
  ],
  [
    "GET /api/staff/feedbacks",
    "feedback.manage",
    () => feedbacksGet(get("/api/staff/feedbacks")),
  ],
  [
    "GET /api/staff/feedbacks/[id]",
    "feedback.manage",
    () =>
      feedbackGet(get("/api/staff/feedbacks/row-1"), idParams("feedbackId")),
    404,
  ],
  [
    "PATCH /api/staff/feedbacks/[id]",
    "feedback.manage",
    () =>
      feedbackPatch(
        send("PATCH", "/api/staff/feedbacks/row-1", { status: "ACKNOWLEDGED" }),
        idParams("feedbackId"),
      ),
    404,
  ],
  [
    "GET /api/staff/moderation/reports",
    "moderation.manage",
    () => reportsGet(get("/api/staff/moderation/reports")),
  ],
  [
    "GET /api/staff/moderation/reports/[id]",
    "moderation.manage",
    () =>
      reportGet(
        get("/api/staff/moderation/reports/row-1"),
        idParams("reportId"),
      ),
    404,
  ],
  [
    "PATCH /api/staff/moderation/reports/[id]",
    "moderation.manage",
    () =>
      reportPatch(
        send("PATCH", "/api/staff/moderation/reports/row-1", {
          status: "UNDER_REVIEW",
          expectedStatus: "PENDING",
          expectedAssignedToId: null,
          reason: REASON,
        }),
        idParams("reportId"),
      ),
    404,
  ],
  [
    "POST /api/staff/moderation/reports/[id]/action",
    "moderation.manage",
    () =>
      reportAction(
        send("POST", "/api/staff/moderation/reports/row-1/action", {
          actionType: "WARNING_ISSUED",
          reason: REASON,
        }),
        idParams("reportId"),
      ),
    404,
  ],
  [
    "POST /api/staff/moderation/reports/[id]/unban",
    "users.moderate",
    () =>
      reportUnban(
        send("POST", "/api/staff/moderation/reports/row-1/unban", {
          reason: REASON,
        }),
        idParams("reportId"),
      ),
    404,
  ],
  [
    "GET /api/staff/moderation/reviews",
    "moderation.manage",
    () => reviewsGet(get("/api/staff/moderation/reviews")),
  ],
  [
    "DELETE /api/staff/moderation/reviews/[id]",
    "users.moderate",
    () =>
      reviewDelete(
        send("DELETE", "/api/staff/moderation/reviews/row-1", {
          reason: REASON,
        }),
        idParams("reviewId"),
      ),
    404,
  ],
  [
    "GET /api/staff/moderation/stats",
    "moderation.manage",
    () => moderationStatsGet(get("/api/staff/moderation/stats")),
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
    const body: unknown = await res.json().catch(() => null);
    expect(status === 403 ? body : { code: "FORBIDDEN" }).toMatchObject({
      code: "FORBIDDEN",
    });
  },
);

it("a refused trial-pricing PATCH never writes the floor", async () => {
  mockViewer.role = "STAFF";
  expect((await floorPatch()).status).toBe(403);
  expect(mockWrite).not.toHaveBeenCalled();
});
