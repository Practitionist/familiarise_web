/** @jest-environment node */
jest.mock("../../lib/data/plan-details", () => ({
  fetchClassPlanDetail: jest.fn(),
  fetchSubscriptionPlanDetail: jest.fn(),
}));
jest.mock("../../lib/data/plan-viewable", () => ({
  canViewPlanDetail: jest.fn(),
}));
jest.mock("../../lib/auth-server", () => ({ getSession: jest.fn() }));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn(),
  brochureDownloadLimiter: {},
  getClientIp: () => "fixture-ip",
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/pdf/plan-brochure-renderer", () => ({
  renderPlanBrochure: jest.fn(),
}));
jest.mock("../../lib/url", () => ({
  getAppUrl: () => "https://familiarise.test",
}));

import { NextRequest, NextResponse } from "next/server";
import { GET as classGet } from "@/app/api/plans/classes/[classPlanId]/brochure/route";
import { GET as subscriptionGet } from "@/app/api/plans/subscriptions/[subscriptionPlanId]/brochure/route";
import {
  fetchClassPlanDetail,
  fetchSubscriptionPlanDetail,
} from "@/lib/data/plan-details";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import { getSession } from "@/lib/auth-server";
import { applyRateLimit } from "@/lib/rate-limit";
import { renderPlanBrochure } from "@/lib/pdf/plan-brochure-renderer";
import type { BrochurePlanType } from "@/lib/pdf/plan-brochure-data";

const plan = {
  id: "plan",
  title: "Design curriculum",
  description: "Learn design",
  language: "English",
  level: "BEGINNER",
  durationInMonths: 1,
  sessionsPerWeek: 1,
  learningOutcomes: [],
  targetAudience: [],
  whatsIncluded: [],
  visibility: "PUBLIC",
  organizationId: null,
  archivedAt: null,
  status: "PUBLISHED",
  classContents: [
    { title: "Foundations", description: "Start here", order: 1 },
  ],
  subscriptionContents: [
    { title: "Your goals", description: "Get started", order: 1 },
  ],
};
async function request(type: BrochurePlanType = "subscriptions") {
  const req = new NextRequest(
    `https://familiarise.test/api/plans/${type}/plan/brochure`,
  );
  return type === "classes"
    ? classGet(req, { params: Promise.resolve({ classPlanId: "plan" }) })
    : subscriptionGet(req, {
        params: Promise.resolve({ subscriptionPlanId: "plan" }),
      });
}
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(fetchClassPlanDetail).mockResolvedValue(plan as never);
  jest.mocked(fetchSubscriptionPlanDetail).mockResolvedValue(plan as never);
  jest.mocked(getSession).mockResolvedValue(null);
  jest.mocked(canViewPlanDetail).mockResolvedValue(true);
  jest.mocked(applyRateLimit).mockResolvedValue(null);
  jest
    .mocked(renderPlanBrochure)
    .mockResolvedValue(Buffer.from("%PDF-fixture"));
});

it.each(["classes", "subscriptions"] as const)(
  "downloads a fresh %s PDF through the detail-page gate without caching",
  async (type) => {
    const response = await request(type);
    expect(response.status).toBe(200);
    expect(getSession).toHaveBeenCalledWith(true);
    expect(canViewPlanDetail).toHaveBeenCalledWith(plan, null);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="design-curriculum-curriculum.pdf"',
    );
    expect(await response.text()).toBe("%PDF-fixture");
    expect(
      type === "classes" ? fetchClassPlanDetail : fetchSubscriptionPlanDetail,
    ).toHaveBeenCalledWith("plan");
  },
);

it.each(["ORG_ONLY", "DRAFT", "ARCHIVED"])(
  "does not render a PDF when the %s detail-page gate denies the visitor",
  async () => {
    jest.mocked(canViewPlanDetail).mockResolvedValue(false);
    const response = await request();
    expect(response.status).toBe(404);
    expect(renderPlanBrochure).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(plan.title);
  },
);

it("does not render missing plans or a missing curriculum", async () => {
  jest.mocked(fetchSubscriptionPlanDetail).mockResolvedValue(null);
  expect((await request()).status).toBe(404);
  expect(canViewPlanDetail).not.toHaveBeenCalled();
  jest
    .mocked(fetchSubscriptionPlanDetail)
    .mockResolvedValue({ ...plan, subscriptionContents: [] } as never);
  expect((await request()).status).toBe(404);
  expect(renderPlanBrochure).not.toHaveBeenCalled();
});

it("fails closed for hidden plans when a fresh session lookup fails", async () => {
  jest.mocked(getSession).mockRejectedValue(new Error("Session unavailable"));
  jest.mocked(canViewPlanDetail).mockResolvedValue(false);
  const response = await request();
  expect(response.status).toBe(404);
  expect(canViewPlanDetail).toHaveBeenCalledWith(plan, null);
  expect(renderPlanBrochure).not.toHaveBeenCalled();
});

it("regenerates from updated content on the next read", async () => {
  await request();
  jest
    .mocked(fetchSubscriptionPlanDetail)
    .mockResolvedValue({ ...plan, title: "Updated plan" } as never);
  await request();
  expect(renderPlanBrochure).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "Updated plan" }),
  );
});

it("rate limits before fetching or rendering", async () => {
  jest
    .mocked(applyRateLimit)
    .mockResolvedValue(
      NextResponse.json({ error: "Limited" }, { status: 429 }),
    );
  expect((await request()).status).toBe(429);
  expect(fetchSubscriptionPlanDetail).not.toHaveBeenCalled();
  expect(renderPlanBrochure).not.toHaveBeenCalled();
});

it("does not leak raw render errors", async () => {
  jest
    .mocked(renderPlanBrochure)
    .mockRejectedValue(new Error("private renderer details"));
  const response = await request();
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private renderer details");
});
