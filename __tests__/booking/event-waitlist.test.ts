/**
 * @jest-environment node
 */

// Notify-me on a sold-out event: the join refusals, the one compare-and-set
// that notifies every eligible waiter, the bell scope, and the shared seat rule.

const findUnique = jest.fn();
const waitlistFindMany = jest.fn();
const waitlistFindUnique = jest.fn();
const waitlistCount = jest.fn();
const waitlistUpsert = jest.fn();
const waitlistUpdateMany = jest.fn(async () => ({ count: 0 }));
const updateManyAndReturn = jest.fn();
const membershipFindMany = jest.fn(async () => [] as { userId: string }[]);
const paymentFindMany = jest.fn(async () => [] as unknown[]);
const participantFindMany = jest.fn(
  async (_args: { where: Record<string, unknown> }) =>
    [] as { userId: string }[],
);
const createManyAndReturn = jest.fn(async ({ data }: { data: unknown[] }) =>
  data.map((row, i) => ({ id: `row-${i}`, ...(row as object) })),
);
const webinarFindUnique = jest.fn();
const classFindUnique = jest.fn();

const tx = {
  appointment: { findUnique },
  webinar: { findUnique: webinarFindUnique },
  class: { findUnique: classFindUnique },
  appointmentWaitlist: {
    findMany: waitlistFindMany,
    findUnique: waitlistFindUnique,
    count: waitlistCount,
    upsert: waitlistUpsert,
    updateMany: waitlistUpdateMany,
    updateManyAndReturn,
  },
  membership: { findMany: membershipFindMany },
  payment: { findMany: paymentFindMany },
  appointmentParticipant: { findMany: participantFindMany },
  notificationOutbox: { createManyAndReturn },
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    webinar: { findUnique: (...a: unknown[]) => webinarFindUnique(...a) },
    class: { findUnique: (...a: unknown[]) => classFindUnique(...a) },
    appointmentWaitlist: {
      findMany: (...a: unknown[]) => waitlistFindMany(...a),
    },
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  },
}));
jest.mock("@/lib/novu/policy", () => ({
  resolveRecipientBellPolicy: jest.fn(async (_w: string, ids: string[]) => ({
    allowedRecipients: ids,
  })),
}));
jest.mock("@/lib/data/plan-viewable", () => ({
  canViewPlanDetail: jest.fn(async () => true),
}));
jest.mock("@/lib/email/senders/booking", () => ({
  EVENT_SEAT_OPENED_EMAIL_TYPE: "EVENT_SEAT_OPENED",
  stageEventSeatOpenedEmails: jest.fn(async () => []),
}));
jest.mock("@/lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));

import {
  finishSeatOpenedNotices,
  joinEventWaitlist,
  listEventWaitlist,
  stageSeatOpenedNotices,
} from "@/lib/booking/event-waitlist";
import { EventWaitlistListResponseSchema } from "@/schemas/interest";
import { INTEREST_RENOTIFY_COOLDOWN_MS } from "@/lib/booking/interest/lifecycle";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import { stageEventSeatOpenedEmails } from "@/lib/email/senders/booking";
import {
  assertSeatRemintable,
  seatRebuyRefusal,
  type PriorSeatPayment,
} from "@/lib/payments/checkout/seats";

const NOW = new Date("2026-11-10T04:30:00.000Z");
const later = new Date(NOW.getTime() + 48 * 3_600_000);

function plan(over: Record<string, unknown> = {}) {
  return {
    id: "plan-1",
    title: "Deep work",
    consultantProfileId: "cp-host",
    organizationId: null,
    visibility: "PUBLIC",
    archivedAt: null,
    maxParticipants: 2,
    waitlistEnabled: true,
    waitlistMax: null,
    consultantProfile: { userId: "u-host", deletedAt: null },
    collaborators: [],
    ...over,
  };
}

function roster(seats: number) {
  return {
    id: "appt-1",
    organizationId: null,
    deletedAt: null,
    occurrences: [
      {
        startsAt: later,
        completionStatus: "SCHEDULED",
        ordinal: 1,
        deletedAt: null,
      },
    ],
    participants: Array.from({ length: seats }, (_, i) => ({
      userId: `seat-${i}`,
    })),
  };
}

/** One free seat on a public webinar unless overridden. */
function eventRow(opts: {
  seats?: number;
  status?: string;
  plan?: Record<string, unknown>;
}) {
  return {
    ...roster(opts.seats ?? 1),
    webinar: {
      id: "web-1",
      status: opts.status ?? "SCHEDULED",
      deletedAt: null,
      maxParticipants: null,
      webinarPlan: plan(opts.plan),
    },
    class: null,
  };
}

/** A running class whose session 1 has started; late join is open until session `cutoff`. */
function runningClass(seats: number, cutoff: number) {
  const { occurrences, ...rest } = roster(seats);
  const started = {
    ...occurrences[0],
    startsAt: new Date(NOW.getTime() - 3_600_000),
    completionStatus: "COMPLETED",
  };
  return {
    roster: {
      ...rest,
      occurrences: [started, { ...occurrences[0], ordinal: 2 }],
    },
    cls: {
      id: "cls-1",
      status: "SCHEDULED",
      deletedAt: null,
      maxParticipants: null,
      classPlan: {
        ...plan(),
        price: 100_000,
        totalSessions: 2,
        lateJoinUntilSession: cutoff,
      },
    },
  };
}

const waiters = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `wl-${i}`, userId: `w-${i}` }));

/** Every delegate call, by name, in order. */
function txCalls(): string[] {
  const named: [string, jest.Mock][] = [
    ["appointment.findUnique", findUnique],
    ["waitlist.findMany", waitlistFindMany],
    ["waitlist.updateMany", waitlistUpdateMany],
    ["waitlist.updateManyAndReturn", updateManyAndReturn],
    ["membership.findMany", membershipFindMany],
    ["payment.findMany", paymentFindMany],
    ["participant.findMany", participantFindMany],
    ["outbox.createManyAndReturn", createManyAndReturn],
  ];
  return named.flatMap(([name, fn]) => fn.mock.calls.map(() => name));
}

beforeEach(() => {
  jest.clearAllMocks();
  updateManyAndReturn.mockImplementation(
    async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({ userId: id.replace("wl-", "w-") })),
  );
});

describe("stageSeatOpenedNotices", () => {
  it("makes the same transaction calls for one waiter as for two hundred", async () => {
    findUnique.mockResolvedValue(eventRow({}));
    waitlistFindMany.mockResolvedValueOnce(waiters(1));
    await stageSeatOpenedNotices(tx as never, "appt-1", NOW);
    const one = txCalls();
    jest.clearAllMocks();
    waitlistFindMany.mockResolvedValueOnce(waiters(200));
    const staged = await stageSeatOpenedNotices(tx as never, "appt-1", NOW);

    expect(txCalls()).toEqual(one);
    expect(waitlistFindMany.mock.calls[0][0]).toMatchObject({
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    expect(staged.pages.map((p) => p.recipients.length)).toEqual([100, 100]);
    expect(staged.email?.userIds).toHaveLength(200);
  });

  it("notifies in one compare-and-set carrying the status and cooldown predicate", async () => {
    findUnique.mockResolvedValue(eventRow({}));
    waitlistFindMany.mockResolvedValueOnce(waiters(3));
    await stageSeatOpenedNotices(tx as never, "appt-1", NOW);

    expect(updateManyAndReturn).toHaveBeenCalledTimes(1);
    expect(updateManyAndReturn.mock.calls[0][0]).toEqual({
      where: {
        appointmentId: "appt-1",
        OR: [
          { status: "WAITING" },
          {
            status: "NOTIFIED",
            notifiedAt: {
              lt: new Date(NOW.getTime() - INTEREST_RENOTIFY_COOLDOWN_MS),
            },
          },
        ],
        id: { in: ["wl-0", "wl-1", "wl-2"] },
      },
      data: { status: "NOTIFIED", notifiedAt: NOW },
      select: { userId: true },
    });
  });

  it.each([
    ["no seat is free", { seats: 2 }],
    ["the webinar is not SCHEDULED", { status: "CANCELLED" }],
    ["the host switched the list off", { plan: { waitlistEnabled: false } }],
  ])("stages nothing when %s", async (_label, opts) => {
    findUnique.mockResolvedValue(eventRow(opts));
    const staged = await stageSeatOpenedNotices(tx as never, "appt-1", NOW);
    expect(staged).toEqual({ pages: [], email: null });
    expect(waitlistFindMany).not.toHaveBeenCalled();
  });

  it("marks a paid waiter BOOKED and skips one with a checkout open", async () => {
    findUnique.mockResolvedValue(eventRow({}));
    waitlistFindMany.mockResolvedValueOnce(waiters(3));
    participantFindMany.mockImplementation(async ({ where }) =>
      "OR" in where ? [{ userId: "w-0" }] : [{ userId: "w-0" }],
    );
    paymentFindMany.mockResolvedValueOnce([
      { userId: "w-1", paymentStatus: "PENDING", amount: 0, refunds: [] },
    ]);
    const staged = await stageSeatOpenedNotices(tx as never, "appt-1", NOW);

    expect(waitlistUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["wl-0"] }, status: { in: ["WAITING", "NOTIFIED"] } },
      data: { status: "BOOKED", bookedAt: NOW },
    });
    expect(staged.email?.userIds).toEqual(["w-2"]);
    participantFindMany.mockReset();
    participantFindMany.mockResolvedValue([]);
  });

  it("scopes a public plan's bell as personal and an org-only plan's to its members' org", async () => {
    findUnique.mockResolvedValue(eventRow({}));
    waitlistFindMany.mockResolvedValueOnce(waiters(1));
    const open = await stageSeatOpenedNotices(tx as never, "appt-1", NOW);
    expect(open.pages[0].payload).toMatchObject({
      scope: "personal",
      organizationId: null,
      checkoutUrl: "/checkout/plans/webinar/plan-1?eventId=web-1",
    });

    findUnique.mockResolvedValue(
      eventRow({ plan: { visibility: "ORG_ONLY", organizationId: "org-1" } }),
    );
    waitlistFindMany.mockResolvedValueOnce(waiters(2));
    membershipFindMany.mockResolvedValueOnce([{ userId: "w-1" }]);
    const orgOnly = await stageSeatOpenedNotices(tx as never, "appt-1", NOW);
    expect(orgOnly.pages[0].recipients).toEqual(["w-1"]);
    expect(orgOnly.pages[0].payload).toMatchObject({
      scope: "org",
      organizationId: "org-1",
    });
    expect(JSON.stringify(findUnique.mock.calls)).not.toContain("quietHours");
  });

  it("claims each email once per waiter and cooldown bucket after the commit", async () => {
    findUnique.mockResolvedValue(eventRow({}));
    waitlistFindMany.mockResolvedValueOnce(waiters(1));
    const staged = await stageSeatOpenedNotices(tx as never, "appt-1", NOW);
    await finishSeatOpenedNotices(staged);

    const bucket = Math.floor(NOW.getTime() / INTEREST_RENOTIFY_COOLDOWN_MS);
    const claim = jest.mocked(stageEventSeatOpenedEmails).mock.calls[0][1];
    expect(claim.scope).toBe("event-waitlist.seat-opened");
    expect(claim.key("w-0")).toBe(`appt-1:${bucket}:w-0`);
    expect(claim.ttlMs).toBe(2 * INTEREST_RENOTIFY_COOLDOWN_MS);
  });
});

describe("joinEventWaitlist", () => {
  const join = (over: Record<string, unknown> = {}) =>
    joinEventWaitlist({
      userId: "u-1",
      viewerConsultantProfileId: null,
      session: null,
      kind: "WEBINAR",
      eventId: "web-1",
      now: NOW,
      ...over,
    });
  const soldOut = (
    opts: { seats?: number; plan?: Record<string, unknown> } = {},
  ) => {
    const row = eventRow({ seats: opts.seats ?? 2, plan: opts.plan });
    webinarFindUnique.mockResolvedValue({
      ...row.webinar,
      appointment: roster(opts.seats ?? 2),
    });
  };

  beforeEach(() => {
    waitlistFindUnique.mockResolvedValue(null);
    waitlistCount.mockResolvedValue(0);
    waitlistUpsert.mockResolvedValue({ status: "WAITING" });
    paymentFindMany.mockResolvedValue([]);
  });

  it("answers a hidden event exactly like a missing one", async () => {
    webinarFindUnique.mockResolvedValueOnce(null);
    await expect(join()).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
      httpStatus: 404,
    });
    soldOut();
    jest.mocked(canViewPlanDetail).mockResolvedValueOnce(false);
    await expect(join()).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
      httpStatus: 404,
    });
  });

  it.each([
    ["seats remain", { seats: 1 }, {}, "EVENT_NOT_FULL"],
    [
      "the host switched it off",
      { plan: { waitlistEnabled: false } },
      {},
      "WAITLIST_DISABLED",
    ],
    [
      "the caller hosts it",
      {},
      { viewerConsultantProfileId: "cp-host" },
      "SELF_BOOKING",
    ],
    ["the caller holds a seat", {}, { userId: "seat-0" }, "ALREADY_REGISTERED"],
  ])("refuses when %s", async (_label, event, caller, code) => {
    soldOut(event);
    await expect(join(caller)).rejects.toMatchObject({ code });
    expect(waitlistUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ["the list is full", [200, 0], "WAITLIST_FULL"],
    ["the caller waits on five events", [3, 5], "EVENT_WAITLIST_CAP"],
  ])("refuses when %s", async (_label, [onList, mine], code) => {
    soldOut();
    waitlistCount.mockResolvedValueOnce(onList).mockResolvedValueOnce(mine);
    await expect(join()).rejects.toMatchObject({ code });
  });

  it.each([
    ["PENDING", { paymentStatus: "PENDING" }, "PAYMENT_ALREADY_EXISTS"],
    [
      "refunded",
      { amount: 500, refunds: [{ amountPaise: 500 }] },
      "SEAT_REBUY_UNSUPPORTED",
    ],
    [
      "left",
      { appointmentParticipants: [{ status: "CANCELLED" }] },
      "SEAT_REBUY_UNSUPPORTED",
    ],
  ])(
    "refuses a %s earlier seat with checkout's own answer",
    async (_l, prior, code) => {
      soldOut();
      paymentFindMany.mockResolvedValueOnce([
        {
          userId: "u-1",
          paymentStatus: "SUCCEEDED",
          amount: 500,
          refunds: [],
          appointmentParticipants: [],
          ...prior,
        },
      ]);
      await expect(join()).rejects.toMatchObject({ code });
    },
  );

  it("returns an open row as it is and reopens an expired one", async () => {
    soldOut();
    waitlistFindUnique.mockResolvedValueOnce({ status: "NOTIFIED" });
    await expect(join()).resolves.toEqual({ status: "NOTIFIED" });
    expect(waitlistUpsert).not.toHaveBeenCalled();

    waitlistFindUnique.mockResolvedValueOnce({ status: "EXPIRED" });
    await join();
    expect(waitlistUpsert.mock.calls[0][0]).toMatchObject({
      where: {
        appointmentId_userId: { appointmentId: "appt-1", userId: "u-1" },
      },
      create: { planKind: "WEBINAR", planId: "plan-1" },
      update: { status: "WAITING", notifiedAt: null, bookedAt: null },
    });
  });
});

describe("the shared seat rule", () => {
  const prior = (over: Partial<PriorSeatPayment>) =>
    ({
      paymentStatus: "SUCCEEDED",
      amount: 500,
      refunds: [],
      appointmentParticipants: [{ status: "CONFIRMED" }],
      ...over,
    }) as PriorSeatPayment;

  it.each([
    [{ paymentStatus: "EXPIRED" }, null],
    [{ paymentStatus: "FAILED" }, null],
    [{ paymentStatus: "PENDING" }, "CHECKOUT_OPEN"],
    [{ refunds: [{ amountPaise: 500 }] }, "REFUNDED"],
    [{ appointmentParticipants: [{ status: "CANCELLED" }] }, "LEFT"],
    [{}, "ALREADY_REGISTERED"],
  ] as const)("classifies %j as %s", (over, refusal) => {
    expect(seatRebuyRefusal(prior(over as Partial<PriorSeatPayment>))).toBe(
      refusal,
    );
  });

  it("keeps checkout's refusal sentences unchanged", () => {
    expect(() =>
      assertSeatRemintable(prior({ paymentStatus: "PENDING" }), "WEBINAR"),
    ).toThrow(/You already have a checkout open for this seat/);
    expect(() =>
      assertSeatRemintable(prior({ refunds: [{ amountPaise: 500 }] }), "CLASS"),
    ).toThrow(/a refunded seat can't be bought again yet/);
    expect(() => assertSeatRemintable(prior({}), "CLASS")).toThrow(
      "You are already enrolled in this class",
    );
  });
});

describe("availability is re-read inside the join transaction", () => {
  it("refuses a join when a seat was released after the first read", async () => {
    const soldOutRow = eventRow({ seats: 2 });
    const freedRow = eventRow({ seats: 1 });
    webinarFindUnique
      .mockResolvedValueOnce({ ...soldOutRow.webinar, appointment: roster(2) })
      .mockResolvedValueOnce({ ...freedRow.webinar, appointment: roster(1) });
    await expect(
      joinEventWaitlist({
        userId: "u-1",
        viewerConsultantProfileId: null,
        session: null,
        kind: "WEBINAR",
        eventId: "web-1",
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FULL" });
    expect(webinarFindUnique).toHaveBeenCalledTimes(2);
    expect(waitlistUpsert).not.toHaveBeenCalled();
  });
});

describe("a running class with late join open counts as on sale", () => {
  const joinClass = () =>
    joinEventWaitlist({
      userId: "u-1",
      viewerConsultantProfileId: null,
      session: null,
      kind: "CLASS",
      eventId: "cls-1",
      now: NOW,
    });

  beforeEach(() => {
    waitlistFindUnique.mockResolvedValue(null);
    waitlistCount.mockResolvedValue(0);
    waitlistUpsert.mockResolvedValue({ status: "WAITING" });
    paymentFindMany.mockResolvedValue([]);
  });

  it("joins while late join is open and refuses once it closes", async () => {
    const open = runningClass(2, 2);
    classFindUnique.mockResolvedValue({
      ...open.cls,
      appointment: open.roster,
    });
    await expect(joinClass()).resolves.toEqual({ status: "WAITING" });

    const closed = runningClass(2, 1);
    classFindUnique.mockResolvedValue({
      ...closed.cls,
      appointment: closed.roster,
    });
    await expect(joinClass()).rejects.toMatchObject({
      code: "ENROLMENT_CLOSED",
    });
  });

  it("notifies waiters when a seat frees on a running class", async () => {
    const { cls, roster: appt } = runningClass(1, 2);
    findUnique.mockResolvedValue({ ...appt, webinar: null, class: cls });
    waitlistFindMany.mockResolvedValueOnce(waiters(1));
    const staged = await stageSeatOpenedNotices(tx as never, "appt-1", NOW);
    expect(staged.email?.checkoutUrl).toBe(
      "/checkout/plans/class/plan-1?eventId=cls-1",
    );
  });
});

describe("listEventWaitlist", () => {
  it("lists the caller's open rows with the next session, checkout link and on-sale state", async () => {
    const notifiedAt = new Date(NOW.getTime() - 3_600_000);
    waitlistFindMany.mockResolvedValueOnce([
      { status: "NOTIFIED", notifiedAt, appointment: eventRow({ seats: 1 }) },
      {
        status: "NOTIFIED",
        notifiedAt,
        appointment: eventRow({ seats: 2 }),
      },
      {
        status: "WAITING",
        notifiedAt: null,
        appointment: eventRow({ status: "CANCELLED" }),
      },
    ]);
    const rows = await listEventWaitlist("u-1", NOW);
    expect(waitlistFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u-1", status: { in: ["WAITING", "NOTIFIED"] } },
      }),
    );
    expect(rows.map((r) => [r.status, r.seatAvailable])).toEqual([
      ["NOTIFIED", true],
      ["NOTIFIED", false],
      ["WAITING", false],
    ]);
    expect(rows[0]).toMatchObject({
      kind: "WEBINAR",
      eventId: "web-1",
      planId: "plan-1",
      planTitle: "Deep work",
      nextSessionAt: later,
      checkoutHref: "/checkout/plans/webinar/plan-1?eventId=web-1",
    });
    const wire = EventWaitlistListResponseSchema.safeParse({
      data: rows.map((r) => ({
        ...r,
        nextSessionAt: r.nextSessionAt?.toISOString() ?? null,
        notifiedAt: r.notifiedAt?.toISOString() ?? null,
      })),
    });
    expect(wire.success).toBe(true);
  });
});
