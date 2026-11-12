/**
 * Every plan detail page must call the visibility gate.
 *
 * The pure predicate already had tests, but nothing asserted that the pages
 * USE it — so the webinar page shipped importing `canViewPlanDetail` and never
 * calling it, leaving ORG_ONLY and archived webinar plans readable by id. These
 * tests drive each page with a hidden plan and require a not-found.
 */

import { Children, type ReactNode } from "react";

const notFoundError = new Error("NEXT_NOT_FOUND");

jest.mock("next/navigation", () => ({
  notFound: jest.fn(() => {
    throw notFoundError;
  }),
}));

const mockCanViewPlanDetail = jest.fn();
jest.mock("../../lib/data/plan-viewable", () => ({
  canViewPlanDetail: (...args: unknown[]) => mockCanViewPlanDetail(...args),
}));

// The pages fetch the session concurrently with the plan and hand it to the
// gate (perf: one round trip instead of two). Pin the session so the gate
// assertion below can verify the handoff.
const mockSession = { user: { id: "user-1" } };
jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(() => Promise.resolve(mockSession)),
}));

const mockGetConsultationPlanDetail = jest.fn();
const mockGetSubscriptionPlanDetail = jest.fn();
const mockGetWebinarPlanDetail = jest.fn();
const mockGetClassPlanDetail = jest.fn();
jest.mock("../../lib/data/plan-details", () => ({
  getConsultationPlanDetail: (...a: unknown[]) =>
    mockGetConsultationPlanDetail(...a),
  getSubscriptionPlanDetail: (...a: unknown[]) =>
    mockGetSubscriptionPlanDetail(...a),
  getExpertPlanClientsFull: async () => false,
  getWebinarPlanDetail: (...a: unknown[]) => mockGetWebinarPlanDetail(...a),
  getClassPlanDetail: (...a: unknown[]) => mockGetClassPlanDetail(...a),
}));

const mockViewerSeatAppointmentIds = jest.fn(async () => [] as string[]);
const mockViewerWaitlistAppointmentIds = jest.fn(async () => [] as string[]);
jest.mock("../../lib/data/viewer-seats", () => ({
  viewerSeatAppointmentIds: (...a: unknown[]) =>
    mockViewerSeatAppointmentIds(...(a as [])),
  viewerWaitlistAppointmentIds: (...a: unknown[]) =>
    mockViewerWaitlistAppointmentIds(...(a as [])),
}));

// The page modules import their presentational components, which drag in the
// whole UI tree. Stub them — these tests are about the gate, not the markup.
jest.mock(
  "../../app/explore/programs/plans/consultations/[consultationPlanId]/components/ConsultationDetails",
  () => ({ ConsultationDetails: () => null }),
);
jest.mock(
  "../../app/explore/programs/plans/subscriptions/[subscriptionPlanId]/components/SubscriptionDetails",
  () => ({ SubscriptionDetails: () => null }),
);
jest.mock(
  "../../app/explore/programs/plans/webinars/[webinarPlanId]/components/WebinarDetails",
  () => ({ WebinarDetails: () => null }),
);
jest.mock(
  "../../app/explore/programs/plans/classes/[classPlanId]/components/ClassDetails",
  () => ({ ClassDetails: () => null }),
);

/** An ORG_ONLY, archived plan — hidden under every rule the gate applies. */
const hiddenPlan = {
  id: "plan-1",
  visibility: "ORG_ONLY" as const,
  organizationId: "org-1",
  archivedAt: new Date("2026-01-01T00:00:00Z"),
  imageUrl: null,
  webinars: [],
  classes: [],
};

/** The slice of a detail page module these tests drive. */
interface PageModule {
  default: (props: { params: Promise<unknown> }) => Promise<unknown>;
  generateMetadata?: (props: {
    params: Promise<unknown>;
  }) => Promise<{ title?: unknown }>;
}
const asPage = (mod: Promise<unknown>) => mod as Promise<PageModule>;

const PAGES = [
  {
    name: "consultation",
    load: () =>
      asPage(
        import("../../app/explore/programs/plans/consultations/[consultationPlanId]/page"),
      ),
    fetcher: mockGetConsultationPlanDetail,
    params: { consultationPlanId: "plan-1" },
  },
  {
    name: "subscription",
    load: () =>
      asPage(
        import("../../app/explore/programs/plans/subscriptions/[subscriptionPlanId]/page"),
      ),
    fetcher: mockGetSubscriptionPlanDetail,
    params: { subscriptionPlanId: "plan-1" },
  },
  {
    name: "webinar",
    load: () =>
      asPage(
        import("../../app/explore/programs/plans/webinars/[webinarPlanId]/page"),
      ),
    fetcher: mockGetWebinarPlanDetail,
    params: { webinarPlanId: "plan-1" },
  },
  {
    name: "class",
    load: () =>
      asPage(
        import("../../app/explore/programs/plans/classes/[classPlanId]/page"),
      ),
    fetcher: mockGetClassPlanDetail,
    params: { classPlanId: "plan-1" },
  },
];

describe("plan detail pages apply canViewPlanDetail", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(PAGES)(
    "$name page 404s a plan the gate rejects",
    async ({ load, fetcher, params }) => {
      fetcher.mockResolvedValue(hiddenPlan);
      mockCanViewPlanDetail.mockResolvedValue(false);

      const Page = (await load()).default;

      await expect(Page({ params: Promise.resolve(params) })).rejects.toThrow(
        "NEXT_NOT_FOUND",
      );
      // Gate receives the concurrently-fetched session, not just the plan.
      expect(mockCanViewPlanDetail).toHaveBeenCalledWith(
        hiddenPlan,
        mockSession,
      );
    },
  );

  it.each(PAGES)(
    "$name page renders a plan the gate allows",
    async ({ load, fetcher, params }) => {
      fetcher.mockResolvedValue(hiddenPlan);
      mockCanViewPlanDetail.mockResolvedValue(true);

      const Page = (await load()).default;

      await expect(
        Page({ params: Promise.resolve(params) }),
      ).resolves.toBeDefined();
    },
  );
});

describe("event detail pages hand down only the viewer's own seat", () => {
  /** The page wraps its details component in a fragment beside the breadcrumb. */
  const propOf = (element: unknown, key: string) =>
    Children.toArray(
      (element as { props: { children: ReactNode } }).props.children,
    )
      .map((child) => (child as { props: Record<string, unknown> }).props)
      .find((childProps) => key in childProps)?.[key];

  beforeEach(() => {
    jest.clearAllMocks();
    mockCanViewPlanDetail.mockResolvedValue(true);
  });

  it("webinar page asks about the signed-in viewer and passes the answer down", async () => {
    mockGetWebinarPlanDetail.mockResolvedValue({
      ...hiddenPlan,
      webinars: [{ id: "w1", appointment: { id: "appt-1", occurrences: [] } }],
    });
    mockViewerSeatAppointmentIds.mockResolvedValue(["appt-1"]);
    mockViewerWaitlistAppointmentIds.mockResolvedValue(["appt-1"]);
    const Page = (
      await import("../../app/explore/programs/plans/webinars/[webinarPlanId]/page")
    ).default;

    const element = await Page({
      params: Promise.resolve({ webinarPlanId: "plan-1" }),
    });

    expect(mockViewerSeatAppointmentIds).toHaveBeenCalledWith("user-1", [
      "appt-1",
    ]);
    expect(propOf(element, "isRegistered")).toBe(true);
    expect(propOf(element, "isWaiting")).toBe(true);
    expect(propOf(element, "viewerUserId")).toBe("user-1");
  });

  it("class page asks about the signed-in viewer across the batches", async () => {
    mockGetClassPlanDetail.mockResolvedValue({
      ...hiddenPlan,
      classes: [
        { id: "c1", appointment: { id: "appt-8" } },
        { id: "c2", appointment: null },
        { id: "c3", appointment: { id: "appt-9" } },
      ],
    });
    mockViewerSeatAppointmentIds.mockResolvedValue(["appt-9"]);
    const Page = (
      await import("../../app/explore/programs/plans/classes/[classPlanId]/page")
    ).default;

    const element = await Page({
      params: Promise.resolve({ classPlanId: "plan-1" }),
    });

    expect(mockViewerSeatAppointmentIds).toHaveBeenCalledWith("user-1", [
      "appt-8",
      "appt-9",
    ]);
    expect(propOf(element, "enrolledAppointmentIds")).toEqual(["appt-9"]);
  });

  it.each([
    [
      "webinar",
      mockGetWebinarPlanDetail,
      "../../app/explore/programs/plans/webinars/[webinarPlanId]/page",
      { webinarPlanId: "plan-1" },
    ],
    [
      "class",
      mockGetClassPlanDetail,
      "../../app/explore/programs/plans/classes/[classPlanId]/page",
      { classPlanId: "plan-1" },
    ],
  ])(
    "%s page reads no seats for a plan the gate rejects",
    async (_name, fetcher, path, params) => {
      fetcher.mockResolvedValue(hiddenPlan);
      mockCanViewPlanDetail.mockResolvedValue(false);
      const Page = (await import(path)).default;

      await expect(Page({ params: Promise.resolve(params) })).rejects.toThrow(
        "NEXT_NOT_FOUND",
      );
      expect(mockViewerSeatAppointmentIds).not.toHaveBeenCalled();
    },
  );
});

// #1527 Q4 (QA D3) — a hidden plan's title must not reach the <title> tag.
describe("plan detail metadata applies the same gate", () => {
  it.each(PAGES)(
    "$name metadata stays generic for a plan the gate rejects",
    async ({ load, fetcher, params }) => {
      fetcher.mockResolvedValue({ ...hiddenPlan, title: "Secret draft" });
      mockCanViewPlanDetail.mockResolvedValue(false);

      const { generateMetadata } = await load();
      if (!generateMetadata) throw new Error("page has no generateMetadata");
      const meta = await generateMetadata({ params: Promise.resolve(params) });

      expect(String(meta.title)).not.toContain("Secret draft");
      expect(mockCanViewPlanDetail).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Secret draft" }),
        mockSession,
      );
    },
  );
});
