/**
 * @jest-environment node
 */

/**
 * The reschedule notice floor: only the consultee side's own moves of the
 * session being cancelled shorten the notice, read from the release record on
 * the reschedule request (original start against the release instant), and it
 * never stands in for a missing live session.
 */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(),
}));

import { resolveBookingRefundContext } from "@/lib/booking/cancellation-scope";
import { quoteBookingRefund } from "@/lib/payments/operations/cancellation-policy";
import type { Tx } from "@/lib/prisma";

const HOUR = 3_600_000;

type Occ = {
  id: string;
  ordinal: number;
  startsAt: Date;
  endsAt: Date;
  completionStatus: string;
  isTentative: boolean;
};

type Request = {
  initiatorRole: "CONSULTEE" | "CONSULTANT";
  status: string;
  createdAt: Date;
  releasedSessions: { ordinal: number; startsAt: string }[] | null;
  releasedOccurrenceIds: string[];
  restoredAt?: Date | null;
};

function occurrence(
  id: string,
  ordinal: number,
  startHours: number,
  completionStatus: string,
): Occ {
  const startsAt = new Date(Date.now() + startHours * HOUR);
  return {
    id,
    ordinal,
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    completionStatus,
    isTentative: false,
  };
}

/** A consultee move of `ordinal` released `noticeHours` before its old start, 12 days ago. */
function move(
  ordinal: number,
  noticeHours: number,
  over: Partial<Request> = {},
): Request {
  const createdAt = new Date(Date.now() - 12 * 24 * HOUR);
  return {
    initiatorRole: "CONSULTEE",
    status: "ACCEPTED",
    createdAt,
    releasedSessions: [
      {
        ordinal,
        startsAt: new Date(
          createdAt.getTime() + noticeHours * HOUR,
        ).toISOString(),
      },
    ],
    releasedOccurrenceIds: [`released-${ordinal}`],
    ...over,
  };
}

/** One booking: its live occurrences and its reschedule requests; a plan when `sessionsTotal` is given. */
function fakeDb(args: {
  occurrences: Occ[];
  requests: Request[];
  sessionsTotal?: number;
}) {
  const db = {
    appointment: {
      findFirst: jest.fn(async () => ({
        id: "appt-1",
        cancellationPolicy: null,
        payment: [
          {
            id: "pay-1",
            amount: 100_000,
            paymentIntent: "order_1",
            refunds: [],
            disputes: [],
          },
        ],
        subscription: args.sessionsTotal
          ? {
              sessionsTotal: args.sessionsTotal,
              sessionsRefunded: 0,
              subscriptionPlan: { totalSessions: args.sessionsTotal },
            }
          : null,
        occurrences: args.occurrences,
      })),
    },
    rescheduleRequest: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: {
            initiatorRole: string;
            status: { not: string };
            restoredAt: null;
          };
        }) =>
          args.requests.filter(
            (r) =>
              r.initiatorRole === where.initiatorRole &&
              r.status !== where.status.not &&
              (r.restoredAt ?? null) === where.restoredAt &&
              r.releasedSessions !== null,
          ),
      ),
    },
    refund: { findMany: jest.fn(async () => []) },
  };
  return db as unknown as Tx;
}

const quoteFor = (
  ctx: Awaited<ReturnType<typeof resolveBookingRefundContext>>,
) =>
  quoteBookingRefund({
    policy: ctx.policy,
    hoursUntilNextSession: ctx.hoursUntilNextSession,
    slotsTotal: ctx.slotsTotal,
    sessionsRefunded: ctx.sessionsRefunded,
    sessionsRemaining: ctx.sessionsRemaining,
    isSubscription: false,
    isConsultantInitiated: false,
    isFreeCreditFunded: false,
    grossPaise: 100_000,
    refundablePaise: 100_000,
  });

const contextOf = (db: Tx) =>
  resolveBookingRefundContext({ appointmentId: "appt-1" }, undefined, db);

describe("reschedule notice floor", () => {
  it("never turns a delivered booking into a positive-notice refund", async () => {
    const ctx = await contextOf(
      fakeDb({
        occurrences: [occurrence("held", 1, -3, "COMPLETED")],
        requests: [move(1, 72)],
      }),
    );
    expect(ctx.hoursUntilNextSession).toBeNull();
    expect(ctx.windowState).toBe("DELIVERED");
    expect(quoteFor(ctx).refundPaise).toBe(0);
  });

  it("applies the consultee's own short-notice move of this session", async () => {
    const ctx = await contextOf(
      fakeDb({
        occurrences: [occurrence("new", 1, 144, "SCHEDULED")],
        requests: [move(1, 3)],
      }),
    );
    expect(ctx.hoursUntilNextSession).toBeCloseTo(3, 3);
    expect(quoteFor(ctx).refundPct).toBe(50);
  });

  it("ignores a move the expert made, however short its notice", async () => {
    const ctx = await contextOf(
      fakeDb({
        occurrences: [occurrence("new", 1, 144, "SCHEDULED")],
        requests: [move(1, 3, { initiatorRole: "CONSULTANT" })],
      }),
    );
    expect(ctx.hoursUntilNextSession).toBeGreaterThan(143);
    expect(quoteFor(ctx).refundPct).toBe(100);
  });

  it("ignores a withdrawn proposal and a declined one that was restored", async () => {
    const ctx = await contextOf(
      fakeDb({
        occurrences: [occurrence("released-1", 1, 144, "SCHEDULED")],
        requests: [
          move(1, 3, { status: "WITHDRAWN" }),
          move(1, 4, { status: "DECLINED", restoredAt: new Date() }),
        ],
      }),
    );
    expect(ctx.hoursUntilNextSession).toBeGreaterThan(143);
  });

  it("counts an expired proposal whose sessions were re-placed", async () => {
    const ctx = await contextOf(
      fakeDb({
        occurrences: [occurrence("replacement", 1, 144, "SCHEDULED")],
        requests: [move(1, 5, { status: "EXPIRED" })],
      }),
    );
    expect(ctx.hoursUntilNextSession).toBeCloseTo(5, 3);
  });

  it("only reads the chain of the session being cancelled", async () => {
    const ctx = await contextOf(
      fakeDb({
        occurrences: [occurrence("next", 1, 144, "SCHEDULED")],
        requests: [move(2, 1)],
      }),
    );
    expect(ctx.hoursUntilNextSession).toBeGreaterThan(143);
  });

  it("gives no floor for a request without a release record", async () => {
    const ctx = await contextOf(
      fakeDb({
        occurrences: [occurrence("next", 1, 144, "SCHEDULED")],
        requests: [move(1, 1, { releasedSessions: null })],
      }),
    );
    expect(ctx.hoursUntilNextSession).toBeGreaterThan(143);
  });

  it("times the notice to the next session that has not ended", async () => {
    // Session 1 ended an hour ago and is not swept yet; session 2 is days out.
    const ctx = await contextOf(
      fakeDb({
        occurrences: [
          occurrence("ended", 1, -2, "SCHEDULED"),
          occurrence("next", 2, 96, "SCHEDULED"),
        ],
        requests: [],
      }),
    );
    expect(ctx.hoursUntilNextSession).toBeGreaterThan(95);
  });
});

/** A session released for a move: its row stays, RESCHEDULED and unconfirmed. */
function released(id: string, ordinal: number, startHours: number): Occ {
  return {
    ...occurrence(id, ordinal, startHours, "RESCHEDULED"),
    isTentative: true,
  };
}

/** A move of `ordinal` opened `agoHours` ago, `noticeHours` before its old start, still unanswered. */
function openMove(
  ordinal: number,
  noticeHours: number,
  agoHours: number,
  over: Partial<Request> = {},
): Request {
  const createdAt = new Date(Date.now() - agoHours * HOUR);
  return move(ordinal, noticeHours, {
    status: "PENDING_REVIEW",
    createdAt,
    releasedSessions: [
      {
        ordinal,
        startsAt: new Date(
          createdAt.getTime() + noticeHours * HOUR,
        ).toISOString(),
      },
    ],
    ...over,
  });
}

/** A four-session plan sold for ₹1,000 on the platform ladder: ₹250 a session. */
const planContextOf = (occurrences: Occ[], requests: Request[]) =>
  contextOf(fakeDb({ occurrences, requests, sessionsTotal: 4 }));

const planQuoteFor = (
  ctx: Awaited<ReturnType<typeof resolveBookingRefundContext>>,
  isConsultantInitiated = false,
) =>
  quoteBookingRefund({
    policy: ctx.policy,
    hoursUntilNextSession: ctx.hoursUntilNextSession,
    slotsTotal: ctx.slotsTotal,
    sessionsRemaining: ctx.sessionsRemaining,
    sessionsTotal: ctx.sessionsTotal,
    sessionsRefunded: ctx.sessionsRefunded,
    sessionsCompleted: ctx.sessionsCompleted,
    scheduledStarts: ctx.scheduledStarts,
    alreadyRefundedPaise: ctx.alreadyRefundedPaise,
    isSubscription: true,
    isConsultantInitiated,
    isFreeCreditFunded: false,
    grossPaise: 100_000,
    refundablePaise: 100_000,
  });

describe("reschedule notice floor on a plan cancel", () => {
  it("prices a session released an hour before its start at its original start while the request is open", async () => {
    // Session 1 was released 30 minutes ago, an hour before its start; session
    // 2 is days out; two sessions were never placed.
    const ctx = await planContextOf(
      [released("released-1", 1, 0.5), occurrence("next", 2, 144, "SCHEDULED")],
      [openMove(1, 1, 0.5)],
    );
    expect(ctx.windowState).toBe("BEFORE");
    expect(planQuoteFor(ctx).refundPaise).toBe(75_000);
  });

  it("keeps the one-hour cap after the move is accepted to a time five days out", async () => {
    const ctx = await planContextOf(
      [
        occurrence("replacement", 1, 120, "SCHEDULED"),
        occurrence("next", 2, 144, "SCHEDULED"),
      ],
      [move(1, 1)],
    );
    expect(planQuoteFor(ctx).refundPaise).toBe(75_000);
  });

  it("prices a session the learner released three hours before its start at the half tier after it moved", async () => {
    const ctx = await planContextOf(
      [
        occurrence("replacement", 1, 120, "SCHEDULED"),
        occurrence("next", 2, 144, "SCHEDULED"),
      ],
      [move(1, 3)],
    );
    expect(planQuoteFor(ctx).refundPaise).toBe(87_500);
  });

  it("leaves a session the expert released at its own notice", async () => {
    const accepted = await planContextOf(
      [
        occurrence("replacement", 1, 120, "SCHEDULED"),
        occurrence("next", 2, 144, "SCHEDULED"),
      ],
      [move(1, 1, { initiatorRole: "CONSULTANT" })],
    );
    expect(planQuoteFor(accepted).refundPaise).toBe(100_000);

    // Still unanswered, its original start three days out.
    const open = await planContextOf(
      [released("released-1", 1, 72), occurrence("next", 2, 144, "SCHEDULED")],
      [openMove(1, 96, 24, { initiatorRole: "CONSULTANT" })],
    );
    expect(planQuoteFor(open).refundPaise).toBe(100_000);
  });

  it("gives full notice to a released session whose time passed with no new one, unless the learner released it", async () => {
    const byExpert = await planContextOf(
      [released("released-1", 1, -3), occurrence("next", 2, 144, "SCHEDULED")],
      [move(1, 1, { initiatorRole: "CONSULTANT", status: "EXPIRED" })],
    );
    expect(planQuoteFor(byExpert).refundPaise).toBe(100_000);

    const byLearner = await planContextOf(
      [released("released-1", 1, -3), occurrence("next", 2, 144, "SCHEDULED")],
      [move(1, 1, { status: "EXPIRED" })],
    );
    expect(planQuoteFor(byLearner).refundPaise).toBe(75_000);
  });

  it("refunds every undelivered session in full when the expert cancels", async () => {
    const ctx = await planContextOf(
      [released("released-1", 1, 0.5), occurrence("next", 2, 144, "SCHEDULED")],
      [openMove(1, 1, 0.5)],
    );
    expect(planQuoteFor(ctx, true).refundPaise).toBe(100_000);
  });

  it("keeps an unpaid hold out of the placed sessions", async () => {
    const hold = {
      ...occurrence("hold", 1, 1, "SCHEDULED"),
      isTentative: true,
    };
    const ctx = await planContextOf([hold], []);
    expect(ctx.scheduledStarts).toEqual([]);
    expect(planQuoteFor(ctx).refundPaise).toBe(100_000);
  });

  it("quotes a plan with no released session off each session's own start", async () => {
    const held = occurrence("held", 1, -72, "COMPLETED");
    const soon = occurrence("soon", 2, 12, "SCHEDULED");
    const later = occurrence("later", 3, 144, "SCHEDULED");
    const ctx = await planContextOf([later, held, soon], []);
    expect(ctx.scheduledStarts).toEqual([
      soon.startsAt.getTime(),
      later.startsAt.getTime(),
    ]);
    // Held: nothing. Twelve hours out: half. Days out and never placed: full.
    expect(planQuoteFor(ctx).refundPaise).toBe(62_500);
  });
});
