/**
 * @jest-environment node
 */

/**
 * `/api/plans/{webinars,classes}/[id]` are public and CDN-cached. A plan only
 * its owner or an org member may see must answer like a missing one for anyone
 * else, and its answer must never enter the shared cache.
 */

jest.mock("@/lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));
jest.mock("@/lib/data/plan-viewable", () => ({
  __esModule: true,
  canViewPlanDetail: jest.fn(),
}));
jest.mock("@/lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: jest.fn(),
}));

import { getSession } from "@/lib/auth-server";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import { reportSentryError } from "@/lib/observability/report";
import { planDetailResponse } from "@/lib/api/plans/detail-response";

const mockGetSession = getSession as jest.Mock;
const mockCanView = canViewPlanDetail as jest.Mock;

const plan = {
  id: "wp-1",
  visibility: "PUBLIC" as const,
  organizationId: null,
  archivedAt: null,
  consultantProfile: null,
};

describe("planDetailResponse", () => {
  it("answers 404 for a plan that does not exist", async () => {
    const res = await planDetailResponse(null, "Webinar plan not found");

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(res.json()).resolves.toEqual({
      error: "Webinar plan not found",
    });
    expect(mockCanView).not.toHaveBeenCalled();
  });

  it("serves a public plan from the shared cache without reading a session", async () => {
    mockCanView.mockResolvedValue(true);

    const res = await planDetailResponse(plan, "not found");

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
    await expect(res.json()).resolves.toEqual({ data: plan });
    expect(mockCanView).toHaveBeenCalledTimes(1);
    expect(mockCanView).toHaveBeenCalledWith(plan, null);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("shows a viewer-only plan to the viewer and keeps it out of the cache", async () => {
    const session = { user: { id: "owner-1" } };
    mockGetSession.mockResolvedValue(session);
    mockCanView.mockImplementation(async (_p, s) => s !== null);

    const res = await planDetailResponse(plan, "not found");

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockCanView).toHaveBeenLastCalledWith(plan, session);
  });

  it("answers a hidden plan exactly like a missing one", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "stranger" } });
    mockCanView.mockResolvedValue(false);

    const res = await planDetailResponse(plan, "Class plan not found");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "Class plan not found" });
    expect(JSON.stringify(body)).not.toContain(plan.id);
    // The 404 depends on who asked, so no shared cache may keep it.
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("treats a failed session lookup as anonymous and reports it once", async () => {
    mockGetSession.mockRejectedValue(new Error("auth down"));
    mockCanView.mockResolvedValue(false);

    const res = await planDetailResponse(plan, "not found");

    expect(res.status).toBe(404);
    expect(mockCanView).toHaveBeenLastCalledWith(plan, null);
    expect(reportSentryError).toHaveBeenCalledTimes(1);
  });
});
