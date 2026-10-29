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

/** One consultation booking: its live occurrences and its reschedule requests. */
function fakeDb(args: {
  occurrences: Occ[];
  requests: Request[];
  restoredIds?: string[];
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
        subscription: null,
        occurrences: args.occurrences,
      })),
    },
    rescheduleRequest: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: { initiatorRole: string; status: { not: string } };
        }) =>
          args.requests.filter(
            (r) =>
              r.initiatorRole === where.initiatorRole &&
              r.status !== where.status.not &&
              r.releasedSessions !== null,
          ),
      ),
    },
    appointmentOccurrence: {
      findMany: jest.fn(
        async ({ where }: { where: { id: { in: string[] } } }) =>
          (args.restoredIds ?? [])
            .filter((id) => where.id.in.includes(id))
            .map((id) => ({ id })),
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
          move(1, 4, { status: "DECLINED" }),
        ],
        restoredIds: ["released-1"],
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
