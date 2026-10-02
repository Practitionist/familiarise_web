/** @jest-environment node */
import { NextRequest } from "next/server";

const mockFetchClass = jest.fn();
const mockFetchWebinar = jest.fn();
const mockFetchConsultation = jest.fn();
const mockFetchSubscription = jest.fn();
const mockCanViewPlanDetail = jest.fn();
const mockGetSession = jest.fn();
const mockApplyRateLimit = jest.fn();
const mockRenderPlanBrochure = jest.fn();
const mockReportSentryError = jest.fn();

jest.mock("../../lib/data/plan-details", () => ({
  fetchClassPlanDetail: (...args: unknown[]) => mockFetchClass(...args),
  fetchWebinarPlanDetail: (...args: unknown[]) => mockFetchWebinar(...args),
  fetchConsultationPlanDetail: (...args: unknown[]) =>
    mockFetchConsultation(...args),
  fetchSubscriptionPlanDetail: (...args: unknown[]) =>
    mockFetchSubscription(...args),
}));

jest.mock("../../lib/data/plan-viewable", () => ({
  canViewPlanDetail: (...args: unknown[]) => mockCanViewPlanDetail(...args),
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => mockApplyRateLimit(...args),
  brochureDownloadLimiter: {},
  getClientIp: () => "127.0.0.1",
}));

jest.mock("../../lib/pdf/plan-brochure-renderer", () => ({
  renderPlanBrochure: (...args: unknown[]) => mockRenderPlanBrochure(...args),
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReportSentryError(...args),
}));

import { handlePlanBrochureDownload } from "../../lib/pdf/plan-brochure-handler";

const samplePlan = {
  id: "plan-123",
  title: "Architecture Deep Dive",
  language: "English",
  level: "INTERMEDIATE",
  price: 100000,
  priceCurrency: "INR",
};

describe("handlePlanBrochureDownload", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApplyRateLimit.mockResolvedValue(null);
    mockGetSession.mockResolvedValue(null);
    mockCanViewPlanDetail.mockResolvedValue(true);
    mockRenderPlanBrochure.mockResolvedValue(Buffer.from("%PDF-1.4-mock"));
  });

  it.each([
    ["classes", mockFetchClass],
    ["webinars", mockFetchWebinar],
    ["consultations", mockFetchConsultation],
    ["subscriptions", mockFetchSubscription],
  ] as const)(
    "returns a 200 application/pdf response for %s plans even without curriculum",
    async (planType, mockFetcher) => {
      mockFetcher.mockResolvedValue(samplePlan);
      const req = new NextRequest(
        `https://familiarise.com/api/plans/${planType}/plan-123/brochure`,
      );
      const res = await handlePlanBrochureDownload(req, "plan-123", planType);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
      expect(res.headers.get("Content-Disposition")).toContain(
        'filename="architecture-deep-dive-brochure.pdf"',
      );
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.toString("utf8")).toBe("%PDF-1.4-mock");
    },
  );

  it("returns 404 when plan is hidden by canViewPlanDetail", async () => {
    mockFetchConsultation.mockResolvedValue(samplePlan);
    mockCanViewPlanDetail.mockResolvedValue(false);
    const req = new NextRequest(
      "https://familiarise.com/api/plans/consultations/plan-123/brochure",
    );
    const res = await handlePlanBrochureDownload(
      req,
      "plan-123",
      "consultations",
    );
    expect(res.status).toBe(404);
  });

  it("reports unexpected render errors to Sentry and returns 500", async () => {
    mockFetchSubscription.mockResolvedValue(samplePlan);
    mockRenderPlanBrochure.mockRejectedValue(new Error("PDF layout failure"));
    const req = new NextRequest(
      "https://familiarise.com/api/plans/subscriptions/plan-123/brochure",
    );
    const res = await handlePlanBrochureDownload(
      req,
      "plan-123",
      "subscriptions",
    );
    expect(res.status).toBe(500);
    expect(mockReportSentryError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ subsystem: "plans", expected: false }),
    );
  });
});
