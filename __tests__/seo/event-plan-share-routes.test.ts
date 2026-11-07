/**
 * @jest-environment node
 */

/**
 * The share image URL is public and cached, so it must be drawn for an
 * anonymous visitor: a plan only anyone may see names itself in it.
 */

const mockGetWebinarPlan = jest.fn();
const mockGetClassPlan = jest.fn();
const mockCanView = jest.fn();
const mockRender = jest.fn();

jest.mock("../../lib/data/plan-details", () => ({
  getWebinarPlanDetail: (...a: unknown[]) => mockGetWebinarPlan(...a),
  getClassPlanDetail: (...a: unknown[]) => mockGetClassPlan(...a),
}));
jest.mock("../../lib/data/plan-viewable", () => ({
  canViewPlanDetail: (...a: unknown[]) => mockCanView(...a),
}));
jest.mock("../../lib/seo/event-plan-share-image", () => ({
  SHARE_IMAGE_SIZE: { width: 1200, height: 630 },
  SHARE_IMAGE_CONTENT_TYPE: "image/png",
  renderEventPlanShareImage: (...a: unknown[]) => mockRender(...a),
}));

import WebinarShareImage from "@/app/explore/programs/plans/webinars/[webinarPlanId]/opengraph-image";
import ClassShareImage from "@/app/explore/programs/plans/classes/[classPlanId]/opengraph-image";

const plan = {
  id: "p-1",
  title: "5-Day LLD Bootcamp",
  consultantProfile: { user: { name: "Arun" } },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetWebinarPlan.mockResolvedValue(plan);
  mockGetClassPlan.mockResolvedValue(plan);
});

describe.each([
  ["webinar", WebinarShareImage, { webinarPlanId: "p-1" }],
  ["class", ClassShareImage, { classPlanId: "p-1" }],
] as const)("%s share image", (kind, Image, params) => {
  it("names the plan and host when an anonymous visitor may see it", async () => {
    mockCanView.mockResolvedValue(true);
    await Image({ params: Promise.resolve(params as never) });
    expect(mockCanView).toHaveBeenCalledWith(plan, null);
    expect(mockRender).toHaveBeenCalledWith({
      kind,
      title: "5-Day LLD Bootcamp",
      host: "Arun",
    });
  });

  it("draws the generic card for a plan an anonymous visitor may not see", async () => {
    mockCanView.mockResolvedValue(false);
    await Image({ params: Promise.resolve(params as never) });
    expect(mockRender).toHaveBeenCalledWith({ kind, title: null, host: null });
  });

  it("draws the generic card when the plan is missing or the read fails", async () => {
    mockGetWebinarPlan.mockRejectedValue(new Error("db down"));
    mockGetClassPlan.mockResolvedValue(null);
    await Image({ params: Promise.resolve(params as never) });
    expect(mockRender).toHaveBeenCalledWith({ kind, title: null, host: null });
    expect(mockCanView).not.toHaveBeenCalledWith(null, null);
  });
});
