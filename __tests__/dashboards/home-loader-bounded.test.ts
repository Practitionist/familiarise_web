/**
 * @jest-environment node
 */

// Invariant: the consultant Home read fetches only what Home renders, keeps at
// most poolLimit() reads in flight (2 on a one-connection pool), and draws
// "this month" on the consultant's own clock.

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantProfile: { findUnique: jest.fn() },
    appointmentOccurrence: {
      findMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    appointment: { findMany: jest.fn() },
    consultation: { findMany: jest.fn(), count: jest.fn() },
    subscription: { findMany: jest.fn(), count: jest.fn() },
    trial: { count: jest.fn(), groupBy: jest.fn() },
    consultantEarnings: {
      count: jest.fn(),
      groupBy: jest.fn(),
      aggregate: jest.fn(),
    },
    consultantReview: {
      aggregate: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
    },
    collaborator: { count: jest.fn() },
    rescheduleRequest: { findMany: jest.fn() },
    appointmentDocument: { count: jest.fn() },
    bookingStatusHistory: { findMany: jest.fn() },
    systemEvent: { findMany: jest.fn() },
  },
}));

import prisma from "@/lib/prisma";
import {
  getConsultantDashboard,
  homeBoundaries,
} from "@/lib/data/consultant-dashboard";

const m = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const NOW = new Date("2026-10-31T20:00:00Z"); // 1 Nov 01:30 in Kolkata

let inFlight = 0;
let peak = 0;
/** Every mocked read takes a tick and records how many overlap. */
function slow<T>(value: T) {
  return jest.fn(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return value;
  });
}

/** A verified, fully configured expert: the setup checklist has nothing left. */
const SET_UP_PROFILE = {
  description: "A".repeat(40),
  headline: "Senior engineer and mentor",
  experience: 8,
  verificationStatus: "VERIFIED",
  scheduleType: "WEEKLY",
  taxInfo: {
    panLast4: "1234",
    gstin: null,
    taxEntityType: "INDIVIDUAL",
    isIndianResident: true,
  },
  payoutAccounts: [{ isVerified: true }],
  _count: {
    subDomains: 1,
    tags: 0,
    availabilityWindowsWeekly: 3,
    availabilityWindowsCustom: 0,
    consultationPlans: 1,
    subscriptionPlans: 0,
    webinarPlans: 0,
    classPlans: 0,
    digitalProducts: 0,
  },
};
const SET_UP_USER = {
  image: "x.png",
  profileDisplayImage: null,
  _count: { workExperiences: 1 },
};

const ORIGINAL_POOL = process.env.PG_POOL_MAX;
beforeEach(() => {
  inFlight = 0;
  peak = 0;
  process.env.PG_POOL_MAX = "1";
  const values: Record<string, Record<string, unknown>> = {
    consultantProfile: {
      findUnique: {
        publishedRatingOneToOne: null,
        publishedRatingGroup: null,
        ratedClientsOneToOne: 0,
        ratedEventsGroup: 0,
        ...SET_UP_PROFILE,
        user: { timezone: "Asia/Kolkata", ...SET_UP_USER },
      },
    },
    appointmentOccurrence: { findMany: [], count: 3, groupBy: [] },
    appointment: { findMany: [] },
    consultation: { findMany: [], count: 1 },
    subscription: { findMany: [], count: 0 },
    trial: { count: 0, groupBy: [] },
    consultantEarnings: { count: 0, groupBy: [], aggregate: {} },
    consultantReview: { aggregate: {}, count: 2, findFirst: null },
    collaborator: { count: 1 },
    rescheduleRequest: { findMany: [] },
    appointmentDocument: { count: 0 },
    bookingStatusHistory: { findMany: [] },
    systemEvent: { findMany: [] },
  };
  for (const [model, methods] of Object.entries(values)) {
    for (const [method, value] of Object.entries(methods)) {
      m[model][method] = slow(value);
    }
  }
});
afterAll(() => {
  process.env.PG_POOL_MAX = ORIGINAL_POOL;
});

describe("consultant Home loader", () => {
  it("returns exactly the fields Home renders", async () => {
    const payload = await getConsultantDashboard("cp-1", NOW);
    expect(Object.keys(payload).sort()).toEqual([
      "appointments",
      "clientBookings",
      "financialSummary",
      "needsYou",
      "orgSessions",
      "payoutSetup",
      "performanceSnapshot",
      "responseRate",
      "sessionsDelivered",
    ]);
    // The requests number rides NeedsYou: the badge's own count.
    expect(payload.needsYou?.requestsToAnswer).toBe(1);
    expect(payload.needsYou?.collabInvites).toBe(1);
    expect(payload.needsYou?.reviewsToReply).toBe(2);
  });

  it("adds the setup checklist only while a step is open", async () => {
    const incomplete = {
      ...SET_UP_PROFILE,
      verificationStatus: "UNDER_REVIEW",
    };
    m.consultantProfile.findUnique = slow({
      ...incomplete,
      user: { timezone: "Asia/Kolkata", ...SET_UP_USER },
    });
    const payload = await getConsultantDashboard("cp-1", NOW);
    expect(
      payload.firstRun?.steps.filter((s) => !s.done).map((s) => s.key),
    ).toEqual(["verify"]);
  });

  it("never runs the reads nobody renders", async () => {
    await getConsultantDashboard("cp-1", NOW);
    expect(m.consultantReview.aggregate).not.toHaveBeenCalled();
    expect(m.consultantEarnings.aggregate).not.toHaveBeenCalled();
    expect(m.trial.groupBy).not.toHaveBeenCalled();
    expect(m.appointmentOccurrence.groupBy).not.toHaveBeenCalled();
    expect(m.consultation.findMany).not.toHaveBeenCalled();
    expect(m.subscription.findMany).not.toHaveBeenCalled();
    expect(m.appointment.findMany).not.toHaveBeenCalled();
  });

  it("keeps at most two reads in flight on a one-connection pool", async () => {
    await getConsultantDashboard("cp-1", NOW);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("counts this and last month's sessions from the 1st in the consultant's zone", async () => {
    const payload = await getConsultantDashboard("cp-1", NOW);
    const ranged = m.appointmentOccurrence.count.mock.calls
      .map(
        ([args]: [{ where: { startsAt?: { gte: Date; lt?: Date } } }]) =>
          args.where.startsAt,
      )
      .filter(Boolean);
    expect(ranged).toEqual([
      { gte: new Date("2026-10-31T18:30:00Z") },
      {
        gte: new Date("2026-09-30T18:30:00Z"),
        lt: new Date("2026-10-31T18:30:00Z"),
      },
    ]);
    expect(payload.sessionsDelivered).toEqual({
      thisMonth: 3,
      lastMonth: 3,
      lifetime: 3,
    });
  });

  it("rolls January back to December of the previous year", () => {
    const { startOfMonth, startOfLastMonth } = homeBoundaries(
      new Date("2026-01-15T10:00:00Z"),
      "Asia/Kolkata",
    );
    expect(startOfMonth).toEqual(new Date("2025-12-31T18:30:00Z"));
    expect(startOfLastMonth).toEqual(new Date("2025-11-30T18:30:00Z"));
  });

  it("carries the newest review with text, first name only, and nothing when anonymous", async () => {
    const review = {
      rating: 5,
      reviewDescription: "  Clear, kind and practical.  ",
      createdAt: new Date("2026-11-05T08:00:00Z"),
      isAnonymous: false,
      consulteeProfile: { user: { name: "Priya Nair" } },
    };
    m.consultantReview.findFirst = slow(review);
    expect((await getConsultantDashboard("cp-1", NOW)).latestReview).toEqual({
      rating: 5,
      body: "Clear, kind and practical.",
      createdAt: "2026-11-05T08:00:00.000Z",
      reviewerFirstName: "Priya",
    });
    m.consultantReview.findFirst = slow({ ...review, isAnonymous: true });
    expect(
      (await getConsultantDashboard("cp-1", NOW)).latestReview
        ?.reviewerFirstName,
    ).toBeNull();
    expect(m.consultantReview.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          consultantProfileId: "cp-1",
          deletedAt: null,
          reviewDescription: { not: null },
        },
      }),
    );
  });
});
