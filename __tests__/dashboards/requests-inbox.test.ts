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
import { GET as getInbox } from "@/app/api/bookings/inbox/route";
import { inboxBucketOf } from "@/lib/dashboard/requests-inbox-state";
import { deriveBookingPresentation } from "@/lib/dashboard/money-state";

const NOW = new Date("2026-09-20T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const hoursAhead = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const CP = "cp-1";

const profile = (id: string, name: string) => ({
  id,
  user: { id: `u-${id}`, name, image: null },
});
const consultant = profile("cp-1", "Asha Rao");

/** One wrapper shape for every row; the factory varies only what a case needs. */
function wrapper(
  id: string,
  opts: {
    occurrences?: {
      startsAt: Date;
      isTentative: boolean;
      completionStatus: string;
    }[];
    payment?: { status: string; amount: number; expiresAt: Date | null }[];
  } = {},
) {
  return {
    id,
    organizationId: null,
    organization: null,
    occurrences: (opts.occurrences ?? []).map((o, i) => ({
      id: `${id}-o${i}`,
      startsAt: o.startsAt,
      endsAt: new Date(o.startsAt.getTime() + 3_600_000),
      isTentative: o.isTentative,
      completionStatus: o.completionStatus,
      deletedAt: null,
    })),
    payment: (opts.payment ?? []).map((p, i) => ({
      id: `${id}-p${i}`,
      amount: p.amount,
      originalAmount: p.amount,
      taxAmount: 0,
      currency: "INR",
      paymentStatus: p.status,
      paymentMethod: "CARD",
      paymentGateway: "RAZORPAY",
      receiptUrl: null,
      expiresAt: p.expiresAt,
      createdAt: hoursAgo(2),
      consumerInvoice: null,
      legs: [],
      refunds: [],
      disputes: [],
    })),
    rescheduleRequests: [],
    statusHistory: [],
  };
}

const pendingConsultation = {
  id: "c-pending",
  status: "PENDING",
  requestedAt: hoursAgo(30),
  bookingSource: "REQUEST_SUBMITTED",
  requestNotes: "Career switch",
  consultationPlan: {
    id: "plan-c",
    title: "Career chat",
    durationInHours: 1,
    price: 150000,
    priceCurrency: "INR",
    consultantProfile: consultant,
  },
  requestedBy: profile("ce-1", "Priya Nair"),
  appointment: wrapper("a-c", {
    occurrences: [
      {
        startsAt: hoursAhead(48),
        isTentative: true,
        completionStatus: "SCHEDULED",
      },
      {
        startsAt: hoursAhead(48.5),
        isTentative: true,
        completionStatus: "SCHEDULED",
      },
    ],
  }),
};

const subscriptionPlan = {
  id: "plan-s",
  title: "Weekly coaching",
  sessionsPerWeek: 2,
  durationInMonths: 3,
  sessionDurationInHours: 1,
  totalSessions: 24,
  price: 2400000,
  priceCurrency: "INR",
  consultantProfile: consultant,
};

const subscriptionBase = {
  bookingSource: "DIRECT_CHECKOUT",
  requestNotes: null,
  schedulingPeriodStartsAt: hoursAgo(24 * 30),
  schedulingPeriodEndsAt: hoursAhead(24 * 60),
  schedulingTimezone: "Asia/Kolkata",
  sessionsTotal: 24,
  subscriptionPlan,
  requestedBy: profile("ce-2", "Rahul Sen"),
};

const awaitingSubscription = {
  ...subscriptionBase,
  id: "s-awaiting",
  status: "APPROVED_PENDING_PAYMENT",
  requestedAt: hoursAgo(5),
  appointment: wrapper("a-s1", {
    occurrences: [
      {
        startsAt: hoursAhead(72),
        isTentative: true,
        completionStatus: "SCHEDULED",
      },
    ],
    payment: [{ status: "PENDING", amount: 2400000, expiresAt: hoursAhead(6) }],
  }),
};

const nextCycleSubscription = {
  ...subscriptionBase,
  id: "s-next",
  status: "APPROVED",
  requestedAt: hoursAgo(24 * 20),
  appointment: wrapper("a-s2", {
    occurrences: [
      {
        startsAt: hoursAgo(24 * 10),
        isTentative: false,
        completionStatus: "COMPLETED",
      },
      {
        startsAt: hoursAgo(24 * 9),
        isTentative: false,
        completionStatus: "COMPLETED",
      },
      {
        startsAt: hoursAgo(24 * 3),
        isTentative: false,
        completionStatus: "COMPLETED",
      },
      {
        startsAt: hoursAgo(24 * 2),
        isTentative: false,
        completionStatus: "COMPLETED",
      },
    ],
    payment: [{ status: "SUCCEEDED", amount: 2400000, expiresAt: null }],
  }),
};

const awaitingTrial = {
  id: "t-awaiting",
  status: "AWAITING_PAYMENT",
  notes: null,
  requestedAt: hoursAgo(10),
  paymentDueAt: hoursAhead(20),
  consulteeProfile: profile("ce-3", "Meera Iyer"),
  subscriptionPlan: {
    id: "plan-s",
    title: "Weekly coaching",
    trialDurationMinutes: 30,
    trialPriceInPaise: 50000,
    priceCurrency: "INR",
    consultantProfile: consultant,
  },
  appointment: wrapper("a-t", {
    occurrences: [
      {
        startsAt: hoursAhead(30),
        isTentative: true,
        completionStatus: "SCHEDULED",
      },
    ],
  }),
};

type Where = { status?: string | { in?: string[] } };
const statusMatches = (row: { status: string }, where: Where) => {
  const s = where.status;
  if (s === undefined) return true;
  if (typeof s === "string") return row.status === s;
  return (s.in ?? []).includes(row.status);
};

/** A tiny fake DB: every read honours `where.status`, nothing else. */
function serve<T extends { status: string }>(rows: T[]) {
  return {
    findMany: async ({ where }: { where: Where }) =>
      rows.filter((r) => statusMatches(r, where)),
    count: async ({ where }: { where: Where }) =>
      rows.filter((r) => statusMatches(r, where)).length,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  const c = serve([pendingConsultation]);
  const s = serve([awaitingSubscription, nextCycleSubscription]);
  const t = serve([awaitingTrial]);
  (prisma.consultation.findMany as jest.Mock).mockImplementation(c.findMany);
  (prisma.consultation.count as jest.Mock).mockImplementation(c.count);
  (prisma.subscription.findMany as jest.Mock).mockImplementation(s.findMany);
  (prisma.subscription.count as jest.Mock).mockImplementation(s.count);
  (prisma.trial.findMany as jest.Mock).mockImplementation(t.findMany);
  (prisma.trial.count as jest.Mock).mockImplementation(t.count);
  (prisma.membership.findMany as jest.Mock).mockResolvedValue([]);
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
