/**
 * @jest-environment node
 */

/**
 * The Deadline view orders by each row's effective deadline (the sooner of
 * its own clock and its requested start less the lead time; a pay link's
 * expiry; a next cycle's window), not by request age, on every view, and
 * pages a bounded window.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findMany: jest.fn(), count: jest.fn() },
    subscription: { findMany: jest.fn(), count: jest.fn() },
    trial: { findMany: jest.fn(), count: jest.fn() },
    membership: { findMany: jest.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import {
  INBOX_RANKED_WINDOW,
  isCursorSort,
  readInboxParams,
  toStampDate,
  type InboxRowInput,
} from "@/lib/dashboard/requests-inbox-state";
import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";

import {
  CP,
  NOW,
  hoursAgo,
  hoursAhead,
  serve,
  serveInboxFixture,
} from "../fixtures/requests-inbox";

type MockPrisma = Parameters<typeof serveInboxFixture>[0];
const m = prisma as unknown as MockPrisma;

const consultant = {
  id: CP,
  user: { id: `u-${CP}`, name: "Asha Rao", image: null },
};
const learner = (id: string) => ({
  id,
  user: { id: `u-${id}`, name: `Learner ${id}`, image: null },
});

function wrapper(
  id: string,
  opts: {
    starts?: Date[];
    payLink?: Date;
  } = {},
) {
  return {
    id,
    organizationId: null,
    organization: null,
    occurrences: (opts.starts ?? []).map((startsAt, i) => ({
      id: `${id}-o${i}`,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      isTentative: true,
      completionStatus: "SCHEDULED",
      deletedAt: null,
    })),
    payment: opts.payLink
      ? [
          {
            id: `${id}-p0`,
            amount: 2400000,
            originalAmount: 2400000,
            taxAmount: 0,
            currency: "INR",
            paymentStatus: "PENDING",
            paymentMethod: "CARD",
            paymentGateway: "RAZORPAY",
            receiptUrl: null,
            expiresAt: opts.payLink,
            createdAt: hoursAgo(2),
            consumerInvoice: null,
            legs: [],
            refunds: [],
            disputes: [],
          },
        ]
      : [],
    rescheduleRequests: [],
    statusHistory: [],
  };
}

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

function subscription(
  id: string,
  status: string,
  requestedAt: Date,
  appointment: ReturnType<typeof wrapper>,
) {
  return {
    id,
    status,
    requestedAt,
    bookingSource: "REQUEST_SUBMITTED",
    requestNotes: null,
    schedulingPeriodStartsAt: hoursAhead(24 * 30),
    schedulingPeriodEndsAt: hoursAhead(24 * 120),
    schedulingTimezone: "Asia/Kolkata",
    sessionsTotal: 24,
    sessionsRefunded: 0,
    planEndsAt: null,
    subscriptionPlan,
    requestedBy: learner(`ce-${id}`),
    appointment,
  };
}

function trial(
  id: string,
  status: "AWAITING_PAYMENT",
  requestedAt: Date,
  paymentDueAt: Date | null,
) {
  return {
    id,
    status,
    notes: null,
    requestedAt,
    paymentDueAt,
    consulteeProfile: learner(`ce-${id}`),
    subscriptionPlan: {
      id: "plan-s",
      title: "Weekly coaching",
      trialDurationMinutes: 30,
      trialPriceInPaise: 50000,
      priceCurrency: "INR",
      consultantProfile: consultant,
    },
    appointment: null,
  };
}

/** Serves `rows` for one model, in request-age order like the SQL. */
function only(
  model: "subscription" | "trial",
  rows: { status: string; requestedAt: Date }[],
) {
  const byAge = [...rows].sort(
    (a, b) => a.requestedAt.getTime() - b.requestedAt.getTime(),
  );
  const fake = serve(byAge);
  m[model].findMany.mockImplementation(fake.findMany);
  m[model].count.mockImplementation(fake.count);
}

const ids = (rows: InboxRowInput[]) => rows.map((r) => r.id);
const deadlineOf = (row: InboxRowInput) =>
  row.deadline === null ? null : toStampDate(row.deadline).getTime();

beforeEach(() => {
  jest.clearAllMocks();
  serveInboxFixture(m);
});

describe("Deadline sort: the effective deadline on a ranked window", () => {
  it("is a ranked sort: no cursor rides the URL for it", () => {
    expect(isCursorSort("deadline")).toBe(false);
    expect(
      readInboxParams(
        (k) => ({ sort: "deadline", after: "1758369600000.c-1" })[k] ?? null,
      ).after,
    ).toBeNull();
  });

  it("a newer request whose requested start is sooner comes before an older one", async () => {
    // Older: asked 10 days ago for a session in 10 days. Newer: asked
    // yesterday for a session in 2 days.
    only("subscription", [
      subscription(
        "s-old",
        "PENDING",
        hoursAgo(24 * 10),
        wrapper("a-old", { starts: [hoursAhead(24 * 10)] }),
      ),
      subscription(
        "s-new",
        "PENDING",
        hoursAgo(24),
        wrapper("a-new", { starts: [hoursAhead(48)] }),
      ),
    ]);
    const page = await readRequestsInbox({
      consultantProfileId: CP,
      type: "subscription",
      chip: "answer-today",
      sort: "deadline",
      page: 1,
      now: NOW,
    });
    expect(ids(page.rows)).toEqual(["s-new", "s-old"]);
    expect(deadlineOf(page.rows[0])).toBe(
      hoursAhead(48).getTime() - MINIMUM_BOOKING_LEAD_TIME_MS,
    );
    expect(page.meta.paging).toBe("ranked");
  });

  it("orders pay links by their expiry, not by when the request came in", async () => {
    only("subscription", [
      subscription(
        "s-old",
        "APPROVED_PENDING_PAYMENT",
        hoursAgo(24 * 5),
        wrapper("a-old", { payLink: hoursAhead(30) }),
      ),
      subscription(
        "s-new",
        "APPROVED_PENDING_PAYMENT",
        hoursAgo(3),
        wrapper("a-new", { payLink: hoursAhead(4) }),
      ),
    ]);
    const page = await readRequestsInbox({
      consultantProfileId: CP,
      type: "subscription",
      chip: "awaiting-payment",
      sort: "deadline",
      page: 1,
      now: NOW,
    });
    expect(ids(page.rows)).toEqual(["s-new", "s-old"]);
    expect(page.rows.map(deadlineOf)).toEqual([
      hoursAhead(4).getTime(),
      hoursAhead(30).getTime(),
    ]);
  });

  it("puts a next cycle that is due now ahead of a pay link due later", async () => {
    // The shared fixture: a next cycle due NOW (asked 20 days ago) and a pay
    // link due in 6 h (asked 5 hours ago).
    const page = await readRequestsInbox({
      consultantProfileId: CP,
      type: "subscription",
      sort: "deadline",
      page: 1,
      now: NOW,
    });
    expect(ids(page.rows)).toEqual(["s-next", "s-awaiting"]);
    expect(page.rows.map(deadlineOf)).toEqual([
      NOW.getTime(),
      hoursAhead(6).getTime(),
    ]);
  });

  it("sorts a row with no clock after every dated row", async () => {
    only("trial", [
      trial("t-undated", "AWAITING_PAYMENT", hoursAgo(48), null),
      trial("t-late", "AWAITING_PAYMENT", hoursAgo(24), hoursAhead(40)),
      trial("t-soon", "AWAITING_PAYMENT", hoursAgo(1), hoursAhead(3)),
    ]);
    const page = await readRequestsInbox({
      consultantProfileId: CP,
      type: "trial",
      sort: "deadline",
      page: 1,
      now: NOW,
    });
    expect(ids(page.rows)).toEqual(["t-soon", "t-late", "t-undated"]);
    expect(deadlineOf(page.rows[2])).toBeNull();
  });

  it("pages the window by deadline: page 2 continues where page 1 stopped", async () => {
    // Five trials whose pay links run out in the reverse of their request order.
    const rows = Array.from({ length: 5 }, (_, i) =>
      trial(
        `t-${i}`,
        "AWAITING_PAYMENT",
        hoursAgo(10 - i),
        hoursAhead(20 - i * 4),
      ),
    );
    only("trial", rows);
    const read = (page: number) =>
      readRequestsInbox({
        consultantProfileId: CP,
        type: "trial",
        sort: "deadline",
        page,
        limit: 2,
        now: NOW,
      });
    const first = await read(1);
    const second = await read(2);
    const third = await read(3);
    expect(ids(first.rows)).toEqual(["t-4", "t-3"]);
    expect(ids(second.rows)).toEqual(["t-2", "t-1"]);
    expect(ids(third.rows)).toEqual(["t-0"]);
    expect(first.meta).toMatchObject({
      paging: "ranked",
      nextCursor: null,
      windowSize: 5,
    });
    // Each source still reads at most the window.
    const call = m.trial.findMany.mock.calls[0][0];
    expect(call.take).toBe(INBOX_RANKED_WINDOW);
  });
});
