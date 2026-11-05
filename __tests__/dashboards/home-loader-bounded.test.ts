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
    consultantReview: { aggregate: jest.fn() },
    rescheduleRequest: { findMany: jest.fn() },
    appointmentDocument: { count: jest.fn() },
    bookingStatusHistory: { findMany: jest.fn() },
    systemEvent: { findMany: jest.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getConsultantDashboard } from "@/lib/data/consultant-dashboard";

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
        user: { timezone: "Asia/Kolkata" },
      },
    },
    appointmentOccurrence: { findMany: [], count: 3, groupBy: [] },
    appointment: { findMany: [] },
    consultation: { findMany: [], count: 1 },
    subscription: { findMany: [], count: 0 },
    trial: { count: 0, groupBy: [] },
    consultantEarnings: { count: 0, groupBy: [], aggregate: {} },
    consultantReview: { aggregate: {} },
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

  it("counts this month's sessions from the 1st in the consultant's zone", async () => {
    const payload = await getConsultantDashboard("cp-1", NOW);
    const monthCall = m.appointmentOccurrence.count.mock.calls.find(
      ([args]: [{ where: { startsAt?: { gte: Date } } }]) =>
        args.where.startsAt,
    );
    expect(monthCall?.[0].where.startsAt.gte).toEqual(
      new Date("2026-10-31T18:30:00Z"),
    );
    expect(payload.sessionsDelivered).toEqual({ thisMonth: 3, lifetime: 3 });
  });
});
