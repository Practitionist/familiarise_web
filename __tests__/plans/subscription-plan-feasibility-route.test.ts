/**
 * @jest-environment node
 */

/**
 * The buyer's feasibility read: counts only, signed-in only, and the same
 * first-week rule checkout enforces.
 */
jest.mock("../../lib/auth-server", () => ({ getSession: jest.fn() }));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => null),
  checkoutContextLimiter: {},
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { subscriptionPlan: { findUnique: jest.fn() } },
}));
const mockPlanBuyBlockedFor = jest.fn(async () => false);
jest.mock("../../lib/booking/plan-demand", () => ({
  ...jest.requireActual("../../lib/booking/plan-demand"),
  planBuyBlockedFor: (...a: unknown[]) => mockPlanBuyBlockedFor(...(a as [])),
}));
jest.mock("../../lib/booking/feasibility", () => {
  const actual = jest.requireActual("../../lib/booking/feasibility");
  return { ...actual, assessExpertFeasibility: jest.fn() };
});

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { assessExpertFeasibility } from "@/lib/booking/feasibility";
import { GET } from "@/app/api/plans/subscriptions/[subscriptionPlanId]/feasibility/route";

const db = prisma as unknown as {
  subscriptionPlan: { findUnique: jest.Mock };
};

const read = (qs = "") =>
  GET(
    new NextRequest(
      `http://localhost/api/plans/subscriptions/plan-1/feasibility${qs}`,
    ),
    { params: Promise.resolve({ subscriptionPlanId: "plan-1" }) },
  );

const week = (placeable: number) => ({
  weekStartMs: 0,
  publishedCapacity: 3,
  placeable,
});

beforeEach(() => {
  jest.clearAllMocks();
  (getSession as jest.Mock).mockResolvedValue({ user: { id: "buyer" } });
  // The route's select: a published public plan of a verified expert.
  db.subscriptionPlan.findUnique.mockResolvedValue({
    status: "PUBLISHED",
    visibility: "PUBLIC",
    organizationId: null,
    archivedAt: null,
    consultantProfileId: "profile-1",
    sessionsPerWeek: 3,
    sessionDurationInHours: 1,
    consultantProfile: {
      verificationStatus: "VERIFIED",
      deletedAt: null,
      user: { timezone: "Asia/Kolkata" },
    },
  });
});

it("refuses an anonymous caller", async () => {
  (getSession as jest.Mock).mockResolvedValue(null);
  expect((await read()).status).toBe(401);
});

it("tells the buyer about thin weeks, counting today's bookings", async () => {
  (assessExpertFeasibility as jest.Mock).mockResolvedValue({
    verdict: "tight",
    weeks: [week(3), week(1), week(3), week(3)],
    longestWindowMinutes: 120,
    bestWeekPublishedSessions: 3,
    reasons: [{ code: "WEEKS_SHORT", message: "x" }],
  });
  const res = await read("?startsAt=2026-11-16T00:00:00.000Z");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    verdict: "tight",
    firstWeekPlaceable: 3,
    sessionsPerWeek: 3,
    notice:
      "This expert currently has room for about 1 of 3 sessions a week. Sessions that can't be scheduled before the plan ends are refunded.",
    fullyBooked: false,
    zone: "Asia/Kolkata",
  });
  expect(assessExpertFeasibility).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      consultantProfileId: "profile-1",
      zone: "Asia/Kolkata",
      sessionMinutes: 60,
      perDayCap: 1,
      countBookings: true,
      weeks: 4,
    }),
  );
});

it("says nothing when every week fits", async () => {
  (assessExpertFeasibility as jest.Mock).mockResolvedValue({
    verdict: "ok",
    weeks: [week(3), week(3), week(3), week(3)],
    longestWindowMinutes: 240,
    bestWeekPublishedSessions: 5,
    reasons: [],
  });
  const body = await (await read()).json();
  expect(body.notice).toBeNull();
});

it("tells a buyer the expert's plan-client limit turns them away, before they pay", async () => {
  (assessExpertFeasibility as jest.Mock).mockResolvedValue({
    verdict: "ok",
    weeks: [week(3), week(3), week(3), week(3)],
    longestWindowMinutes: 240,
    bestWeekPublishedSessions: 5,
    reasons: [],
  });
  mockPlanBuyBlockedFor.mockResolvedValueOnce(true);
  const body = await (await read()).json();
  expect(body.fullyBooked).toBe(true);
  expect(mockPlanBuyBlockedFor).toHaveBeenCalledWith(
    expect.anything(),
    "profile-1",
    "buyer",
  );
});

it("rejects a malformed start", async () => {
  expect((await read("?startsAt=tomorrow")).status).toBe(400);
});
