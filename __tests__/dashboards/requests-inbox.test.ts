/**
 * @jest-environment node
 */

/**
 * #1775 PR-A — the Requests inbox read and its HTTP twin. One fixture (a
 * PENDING consultation, an APPROVED_PENDING_PAYMENT subscription, a
 * next-cycle subscription and an AWAITING_PAYMENT trial) served by a
 * where-aware prisma mock, so the same rows answer the read, the route and
 * the Home-parity pin (A-6).
 */

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: jest.fn(),
  isPrivileged: jest.fn(() => false),
  forbiddenResponse: jest.fn(
    (message: string) =>
      new Response(JSON.stringify({ error: message }), { status: 403 }),
  ),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findMany: jest.fn(), count: jest.fn() },
    subscription: { findMany: jest.fn(), count: jest.fn() },
    trial: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
    membership: { findMany: jest.fn() },
    appointmentOccurrence: { findMany: jest.fn(), groupBy: jest.fn() },
    appointment: { findMany: jest.fn() },
    activityLog: { findMany: jest.fn() },
    consultantEarnings: { aggregate: jest.fn(), count: jest.fn() },
    consultantReview: { aggregate: jest.fn() },
    bookingStatusHistory: { findMany: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import { getConsultantDashboard } from "@/lib/data/consultant-dashboard";
import { GET as getInbox } from "@/app/api/bookings/inbox/route";
import { inboxBucketOf } from "@/lib/dashboard/requests-inbox-state";
import { deriveBookingPresentation } from "@/lib/dashboard/money-state";

import {
  CP,
  NOW,
  hoursAhead,
  serveInboxFixture,
} from "../fixtures/requests-inbox";

type MockPrisma = Parameters<typeof serveInboxFixture>[0];

beforeEach(() => {
  jest.clearAllMocks();
  serveInboxFixture(prisma as unknown as MockPrisma);
});
const read = (args: Partial<Parameters<typeof readRequestsInbox>[0]> = {}) =>
  readRequestsInbox({
    consultantProfileId: CP,
    type: "consultation",
    sort: "priority",
    page: 1,
    now: NOW,
    ...args,
  });

describe("readRequestsInbox (A-1)", () => {
  it("names every kind, derives each deadline and buckets the four rows", async () => {
    const consultations = await read({ type: "consultation" });
    const subscriptions = await read({ type: "subscription" });
    const trials = await read({ type: "trial" });
    const rows = [...consultations.rows, ...subscriptions.rows, ...trials.rows];
    // Priority within a bucket: amount desc, then the nearer clock first.
    expect(rows.map((r) => [r.id, r.kind])).toEqual([
      ["c-pending", "consultation"],
      ["s-next", "next-cycle"],
      ["s-awaiting", "subscription"],
      ["t-awaiting", "trial"],
    ]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    // PENDING → the 48 h hold; awaiting payment → the pay link's clock;
    // next cycle → the window start; a paid trial → paymentDueAt.
    expect(new Date(byId["c-pending"].deadline!)).toEqual(hoursAhead(18));
    expect(new Date(byId["s-awaiting"].deadline!)).toEqual(hoursAhead(6));
    expect(new Date(byId["s-next"].deadline!)).toEqual(NOW);
    expect(new Date(byId["t-awaiting"].deadline!)).toEqual(hoursAhead(20));
    expect(rows.map((r) => r.bucket)).toEqual([
      "answer-today",
      "waiting-on-them",
      "waiting-on-them",
      "waiting-on-them",
    ]);
    // The subscription's words: the next batch and the booked count, never "slots".
    expect(byId["s-next"].entitlement).toMatchObject({
      total: 24,
      held: 4,
      cycle: { nextBatch: 2 },
    });
    expect(byId["t-awaiting"].amountPaise).toBe(50000);
    expect(subscriptions.meta).toMatchObject({
      total: 2,
      counts: { consultation: 1, subscription: 2, trial: 1 },
    });
    // The presentation reads the row through money-state, not a status switch.
    const { bookingState, moneyState } = deriveBookingPresentation(
      byId["s-awaiting"].presentation,
      "CONSULTANT",
      { now: NOW },
    );
    expect(bookingState.state).toBe("AWAITING_PAYMENT");
    expect(moneyState.state).toBe("DUE");
  });

  it("sort=deadline orders by the clock and chip=awaiting-payment narrows to one", async () => {
    const sorted = await read({ type: "subscription", sort: "deadline" });
    expect(sorted.rows.map((r) => r.id)).toEqual(["s-next", "s-awaiting"]);
    const chipped = await read({
      type: "subscription",
      chip: "awaiting-payment",
    });
    expect(chipped.rows.map((r) => r.id)).toEqual(["s-awaiting"]);
    expect(chipped.meta.total).toBe(1);
    // The scan is stable: requestedAt desc with the id tiebreaker (#1704 P1).
    const call = (prisma.subscription.findMany as jest.Mock).mock.calls[0][0];
    expect(call.orderBy).toEqual([{ requestedAt: "desc" }, { id: "asc" }]);
  });

  it("the bucket rule: only a REQUESTED row is the consultant's to answer", () => {
    expect(
      inboxBucketOf(
        { kind: "consultation", deadline: hoursAhead(30) },
        "REQUESTED",
        NOW,
      ),
    ).toBe("this-week");
    expect(
      inboxBucketOf({ kind: "trial", deadline: null }, "REQUESTED", NOW),
    ).toBe("answer-today");
    expect(
      inboxBucketOf(
        { kind: "subscription", deadline: hoursAhead(6) },
        "AWAITING_PAYMENT",
        NOW,
      ),
    ).toBe("waiting-on-them");
  });
});

describe("GET /api/bookings/inbox (A-2)", () => {
  const session = (consultantProfileId: string) => ({
    session: {
      user: { id: "u-1", role: "CONSULTANT", consultantProfileId },
    },
  });
  const call = (query: string) =>
    getInbox(new NextRequest(`http://localhost/api/bookings/inbox?${query}`));

  it("answers 400 for a sort it does not know", async () => {
    (requireApiAuth as jest.Mock).mockResolvedValue(session(CP));
    const res = await call(`consultantProfileId=${CP}&sort=xyz`);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_ERROR");
  });

  it("answers 403 for a foreign consultantProfileId and no-store for its own", async () => {
    (requireApiAuth as jest.Mock).mockResolvedValue(session("cp-other"));
    expect((await call(`consultantProfileId=${CP}`)).status).toBe(403);
    (requireApiAuth as jest.Mock).mockResolvedValue(session(CP));
    const res = await call(`consultantProfileId=${CP}&type=trial`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).rows.map((r: { id: string }) => r.id)).toEqual([
      "t-awaiting",
    ]);
  });
});

describe("Home strip parity (A-6)", () => {
  it("Home's answer / awaiting / next-cycle strips add up to the inbox tab counts", async () => {
    const m = prisma as unknown as Record<string, Record<string, jest.Mock>>;
    m.appointmentOccurrence.findMany.mockResolvedValue([]);
    m.appointmentOccurrence.groupBy.mockResolvedValue([]);
    m.appointment.findMany.mockResolvedValue([]);
    m.activityLog.findMany.mockResolvedValue([]);
    m.trial.groupBy.mockResolvedValue([]);
    m.bookingStatusHistory.findMany.mockResolvedValue([]);
    m.consultantEarnings.count.mockResolvedValue(0);
    m.consultantEarnings.aggregate.mockResolvedValue({
      _sum: { consultantSharePaise: null, refundedShareAmount: null },
    });
    m.consultantReview.aggregate.mockResolvedValue({
      _avg: { rating: null },
      _count: { rating: 0 },
    });
    const home = await getConsultantDashboard(CP);
    const inbox = await read({ type: "consultation" });
    // Same predicates (needs-you.ts) on both sides: 1 pending + 1 awaiting + 1 next cycle.
    expect(
      home.pendingRequestsCount +
        home.awaitingPayment.count +
        home.nextCycles.length,
    ).toBe(3);
    expect(
      inbox.meta.counts.consultation + inbox.meta.counts.subscription,
    ).toBe(3);
  });
});
