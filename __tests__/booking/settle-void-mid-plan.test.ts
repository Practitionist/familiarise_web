/**
 * @jest-environment node
 */

/**
 * A voided subscription session is not settled mid-plan: while the plan runs
 * the entitlement still offers it. Only when the fixed plan end has passed
 * does the plan settle, once, through a durable `plan-end:` owed marker for
 * every session not delivered.
 */

const refundBookingPayment = jest.fn(async () => ({
  refundId: "rf",
  amountRefundedPaise: 10_000,
  rail: "GATEWAY",
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => refundBookingPayment(...(a as [])),
}));
jest.mock("../../lib/payments/operations/credit-plan-return", () => ({
  creditStillUsedPaise: async () => state.creditStillUsed,
}));
const stampRefundOwed = jest.fn(async (..._a: unknown[]) => true);
const driveRefundOwed = jest.fn(async (..._a: unknown[]) => ({
  kind: "refunded",
  refund: { refundId: "rf", amountRefundedPaise: 1 },
}));
jest.mock("../../lib/payments/operations/refund-owed", () => ({
  stampRefundOwed: (...a: unknown[]) => stampRefundOwed(...a),
  driveRefundOwed: (...a: unknown[]) => driveRefundOwed(...a),
}));
const transitionSubscriptionRequest = jest.fn(async (..._a: unknown[]) => {});
jest.mock("../../lib/booking/transitions", () => ({
  ...jest.requireActual("../../lib/booking/transitions"),
  transitionSubscriptionRequest: (...a: unknown[]) =>
    transitionSubscriptionRequest(...a),
}));
const stampTranchesOnCancel = jest.fn(async (..._a: unknown[]) => 0);
jest.mock("../../lib/booking/subscription-cycle", () => ({
  stampTranchesOnCancel: (...a: unknown[]) => stampTranchesOnCancel(...a),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_k: string, _o: unknown, fn: () => unknown) => fn(),
  // The run trail: what the previous tick left for this one.
  readJobCheckpoint: async () => state.checkpoint,
}));
// The deadline lands once the run has opened `budget` plans.
jest.mock("../../lib/cron/run-deadline", () => ({
  ...jest.requireActual("../../lib/cron/run-deadline"),
  startDeadline: () => () => state.opened.length >= state.budget,
}));
jest.mock("../../lib/novu/outbox", () => ({ stageTrigger: jest.fn() }));
const stageBell = jest.fn(async (_tx: unknown, args: unknown) => ({
  staged: args,
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: (tx: unknown, args: unknown) => stageBell(tx, args),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: async () => {},
}));
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: (_id: string, fn: () => unknown) => fn(),
}));

const NOW = new Date("2026-05-20T06:00:00Z");
const PURCHASED = new Date("2026-04-01T06:00:00Z");

type Plan = {
  id: string;
  status: string;
  sessionsTotal: number;
  planEndsAt: Date | null;
  schedulingPeriodStartsAt: Date;
  schedulingTimezone: string;
  // Read only by the pre-plan-end sweep's arm; the first-cycle end.
  schedulingPeriodEndsAt: Date;
  subscriptionPlan: {
    title: string;
    totalSessions: number;
    durationInMonths: number;
  };
  appointment: { id: string };
};

const plan = (over: Partial<Plan> = {}): Plan => ({
  id: "sub-1",
  status: "APPROVED",
  sessionsTotal: 12,
  planEndsAt: new Date("2026-07-01T06:00:00Z"),
  schedulingPeriodStartsAt: PURCHASED,
  schedulingTimezone: "Asia/Kolkata",
  schedulingPeriodEndsAt: new Date("2026-04-07T18:30:00Z"),
  subscriptionPlan: {
    title: "Mentoring",
    totalSessions: 12,
    durationInMonths: 3,
  },
  appointment: { id: "apt-1" },
  ...over,
});

/** What the settling commit re-reads; by default the same row as the cohort. */
const settleRead = (p: Plan) => ({
  ...p,
  requestedBy: { user: { id: "u-learner", name: "Asha" } },
  subscriptionPlan: {
    ...p.subscriptionPlan,
    consultantProfile: { user: { id: "u-expert", name: "Ravi" } },
  },
  appointment: { organizationId: null },
});

const delivered = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `d${i}`,
    completionStatus: "COMPLETED",
    seatsSettledAt: null,
  }));

const state = {
  plan: plan(),
  reread: null as Plan | null,
  rows: [] as { id: string; completionStatus: string; seatsSettledAt: null }[],
  undecided: 0,
  refunds: [] as { amountPaise: number; status: string }[],
  payment: { amount: 120_000, paymentIntent: "order_1" },
  /** Referral credit the plan's payment still holds consumed. */
  creditStillUsed: 50_000,
  /** When set, the stored-end cohort is this list, paged by its keyset. */
  cohort: null as Plan[] | null,
  waiting: new Set<string>(),
  opened: [] as string[],
  budget: Infinity,
  checkpoint: null as string | null,
};

type KeysetWhere = {
  planEndsAt: unknown;
  OR?: [unknown, { planEndsAt: Date; id: { gt: string } }];
};
const key = (p: Plan) => `${p.planEndsAt?.toISOString()}|${p.id}`;
/** The stored-end cohort as Postgres would page it. */
const cohortPage = (where: KeysetWhere, take: number) => {
  if (where.planEndsAt === null) return [];
  const tie = where.OR?.[1];
  const after = tie ? `${tie.planEndsAt.toISOString()}|${tie.id.gt}` : "";
  return (state.cohort ?? [])
    .filter((p) => key(p) > after)
    .sort((a, b) => key(a).localeCompare(key(b)))
    .slice(0, take);
};
const systemEventCreate = jest.fn(async (..._a: unknown[]) => ({}));
const occurrenceUpdateMany = jest.fn(async (..._a: unknown[]) => ({
  count: 1,
}));
const subscriptionUpdateMany = jest.fn(async (..._a: unknown[]) => ({
  count: 1,
}));

const VOID_SESSION = () => ({
  id: "v1",
  appointmentId: "apt-1",
  ordinal: 3,
  startsAt: new Date("2026-04-10T06:00:00Z"),
  completionStatus: "VOIDED",
  appointment: { subscription: state.plan },
});

jest.mock("../../lib/prisma", () => {
  const db = {
    appointmentOccurrence: {
      // The day-14 cohort answers only the arms its WHERE asks for: a void on
      // a subscription comes back only when the WHERE names subscriptions.
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        if ("appointmentId" in where) return state.rows;
        return JSON.stringify(where).includes('"subscription"') &&
          state.plan.schedulingPeriodEndsAt < NOW
          ? [VOID_SESSION()]
          : [];
      },
      findFirst: async () => null,
      count: async () => state.undecided,
      updateMany: (...a: unknown[]) => occurrenceUpdateMany(...a),
    },
    subscription: {
      // The stored-end arm asks for planEndsAt <= now, the derived arm for null;
      // the completed-plan voids arm (no COMPLETED plan here) finds nothing.
      findMany: async ({
        where,
        take,
      }: {
        where: KeysetWhere & { status?: unknown };
        take: number;
      }) =>
        where.status === "COMPLETED"
          ? []
          : state.cohort
            ? cohortPage(where, take)
            : (where.planEndsAt === null) === (state.plan.planEndsAt === null)
              ? [state.plan]
              : [],
      findUnique: async ({ where }: { where: { id: string } }) => {
        state.opened.push(where.id);
        const found = state.cohort?.find((p) => p.id === where.id);
        if (!found) return settleRead(state.reread ?? state.plan);
        // A plan that must wait reads as no longer live.
        return settleRead(
          state.waiting.has(found.id)
            ? { ...found, status: "COMPLETED" }
            : found,
        );
      },
      updateMany: (...a: unknown[]) => subscriptionUpdateMany(...a),
    },
    rescheduleRequest: { findFirst: async () => null },
    payment: {
      findMany: async () => [
        {
          id: "pay-1",
          ...state.payment,
          currency: "INR",
          userId: "u-1",
          refunds: state.refunds,
          disputes: [],
        },
      ],
      findUnique: async () => ({ refunds: state.refunds, disputes: [] }),
    },
    refund: { findUnique: async () => null },
    consultantEarnings: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    organizationEarnings: { updateMany: async () => ({ count: 0 }) },
    systemEvent: {
      findFirst: async () => null,
      create: (...a: unknown[]) => systemEventCreate(...a),
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { __esModule: true, default: db };
});

import {
  parsePlanCursor,
  settleCancelledSessions,
} from "@/scripts/appointments/settle-cancelled-sessions";

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(NOW);
  state.plan = plan();
  state.reread = null;
  state.rows = [
    ...delivered(9),
    { id: "v1", completionStatus: "VOIDED", seatsSettledAt: null },
  ];
  state.undecided = 0;
  state.refunds = [];
  state.payment = { amount: 120_000, paymentIntent: "order_1" };
  state.creditStillUsed = 50_000;
  state.cohort = null;
  state.waiting = new Set();
  state.opened = [];
  state.budget = Infinity;
  state.checkpoint = null;
});
afterEach(() => jest.useRealTimers());

it("a mid-plan void with nothing scheduled is not paid back while the plan runs", async () => {
  await settleCancelledSessions();
  expect(refundBookingPayment).not.toHaveBeenCalled();
  expect(stampRefundOwed).not.toHaveBeenCalled();
  expect(driveRefundOwed).not.toHaveBeenCalled();
  expect(transitionSubscriptionRequest).not.toHaveBeenCalled();
});

it("at plan end, every undelivered session settles pro rata through one plan-end marker", async () => {
  state.plan = plan({ planEndsAt: new Date("2026-05-15T06:00:00Z") });
  await settleCancelledSessions();
  // 9 of 12 delivered: the void and two never-placed sessions are owed.
  const marker = {
    paymentId: "pay-1",
    amountPaise: 30_000,
    key: "plan-end:sub-1:pay:pay-1",
    reason: "PLAN_ENDED_UNUSED_SESSIONS",
  };
  // The CAS carries the status and plan end the commit re-read.
  expect(transitionSubscriptionRequest).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      where: { id: "sub-1", planEndsAt: new Date("2026-05-15T06:00:00Z") },
      to: "COMPLETED",
      fromIn: ["APPROVED"],
    }),
  );
  // Both parties hear the plan ended, once.
  expect(stageBell).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      recipients: ["u-learner", "u-expert"],
      dedupeKey: "plan-end:sub-1",
    }),
  );
  expect(stampRefundOwed).toHaveBeenCalledWith(expect.anything(), marker);
  expect(driveRefundOwed).toHaveBeenCalledWith(marker);
  expect(stampTranchesOnCancel).toHaveBeenCalledWith(expect.anything(), {
    paymentId: "pay-1",
    now: NOW,
  });
  // The plan's voids are settled in the same commit.
  expect(occurrenceUpdateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        appointmentId: "apt-1",
        completionStatus: "VOIDED",
        seatsSettledAt: null,
      }),
    }),
  );
  expect(refundBookingPayment).not.toHaveBeenCalled();
});

it("subtracts what the payment already returned", async () => {
  state.plan = plan({ planEndsAt: new Date("2026-05-15T06:00:00Z") });
  state.refunds = [{ amountPaise: 10_000, status: "SUCCEEDED" }];
  await settleCancelledSessions();
  expect(stampRefundOwed).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ amountPaise: 20_000 }),
  );
});

it("derives the end of a plan with no stored end from its start", async () => {
  // Bought 1 Apr for 1 month: over on 1 May.
  state.plan = plan({
    planEndsAt: null,
    subscriptionPlan: {
      title: "Mentoring",
      totalSessions: 12,
      durationInMonths: 1,
    },
  });
  await settleCancelledSessions();
  expect(transitionSubscriptionRequest).toHaveBeenCalled();
});

it("waits while a session is undecided, writing nothing to the plan", async () => {
  state.plan = plan({ planEndsAt: new Date("2026-05-15T06:00:00Z") });
  state.undecided = 1;
  await settleCancelledSessions();
  expect(transitionSubscriptionRequest).not.toHaveBeenCalled();
  expect(stampRefundOwed).not.toHaveBeenCalled();
  expect(subscriptionUpdateMany).not.toHaveBeenCalled();
});

it("re-reads the plan under the lock: an extension that landed first wins", async () => {
  state.plan = plan({ planEndsAt: new Date("2026-05-15T06:00:00Z") });
  state.reread = plan({ planEndsAt: new Date("2026-05-22T06:00:00Z") });
  await settleCancelledSessions();
  expect(transitionSubscriptionRequest).not.toHaveBeenCalled();
  expect(stampRefundOwed).not.toHaveBeenCalled();
});

it("settles, without money, the voids of plans their own refund path paid", async () => {
  await settleCancelledSessions();
  // A COMPLETED plan is not here: its unsettled void goes through the money.
  expect(occurrenceUpdateMany).toHaveBeenCalledWith({
    where: {
      completionStatus: "VOIDED",
      seatsSettledAt: null,
      deletedAt: null,
      appointment: {
        subscription: {
          status: { in: ["CANCELLED", "EXPIRED", "REJECTED"] },
        },
      },
    },
    data: { seatsSettledAt: NOW },
  });
  expect(refundBookingPayment).not.toHaveBeenCalled();
});

it("waits behind another door's owed refund instead of overwriting it", async () => {
  state.plan = plan({ planEndsAt: new Date("2026-05-15T06:00:00Z") });
  stampRefundOwed.mockResolvedValueOnce(false);
  const result = await settleCancelledSessions();
  expect(driveRefundOwed).not.toHaveBeenCalled();
  expect(result.errors).toBe(0);
});

it("a fully delivered plan completes with nothing owed", async () => {
  state.plan = plan({ planEndsAt: new Date("2026-05-15T06:00:00Z") });
  state.rows = delivered(12);
  await settleCancelledSessions();
  expect(transitionSubscriptionRequest).toHaveBeenCalled();
  expect(stampRefundOwed).not.toHaveBeenCalled();
});

describe("a plan paid wholly in referral credit", () => {
  beforeEach(() => {
    state.plan = plan({ planEndsAt: new Date("2026-05-15T06:00:00Z") });
    state.payment = { amount: 0, paymentIntent: "free_1730000000_abc" };
  });

  it("with nothing delivered, restores the whole credit under the plan-end key", async () => {
    state.rows = [];
    await settleCancelledSessions();
    const marker = {
      paymentId: "pay-1",
      amountPaise: null,
      key: "plan-end:sub-1:pay:pay-1",
      reason: "PLAN_ENDED_UNUSED_SESSIONS",
    };
    expect(stampRefundOwed).toHaveBeenCalledWith(expect.anything(), marker);
    expect(driveRefundOwed).toHaveBeenCalledWith(marker);
  });

  it("with some sessions delivered, queues the rest for a human and holds no tranche", async () => {
    await settleCancelledSessions();
    expect(stampRefundOwed).not.toHaveBeenCalled();
    expect(driveRefundOwed).not.toHaveBeenCalled();
    expect(stampTranchesOnCancel).not.toHaveBeenCalled();
    expect(systemEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          correlationId: "partial-credit:pay-1",
        }),
      }),
    );
    expect(transitionSubscriptionRequest).toHaveBeenCalled();
  });

  it("a plan paid by a 100% discount has no credit to return: no review, tranches held", async () => {
    state.creditStillUsed = 0;
    await settleCancelledSessions();
    expect(systemEventCreate).not.toHaveBeenCalled();
    expect(stampRefundOwed).not.toHaveBeenCalled();
    expect(stampTranchesOnCancel).toHaveBeenCalledWith(expect.anything(), {
      paymentId: "pay-1",
      now: NOW,
    });
    expect(transitionSubscriptionRequest).toHaveBeenCalled();
  });
});

describe("the plan-end pass resumes where the last run stopped", () => {
  // 51 ended plans, a minute apart, in plan-end order.
  const ended = Array.from({ length: 51 }, (_, i) =>
    plan({
      id: `sub-${String(i + 1).padStart(2, "0")}`,
      planEndsAt: new Date(Date.UTC(2026, 4, 15, 6, i)),
    }),
  );
  const settled = () =>
    transitionSubscriptionRequest.mock.calls.map(
      (c) => (c[1] as { where: { id: string } }).where.id,
    );
  const tick = async () => {
    const result = await settleCancelledSessions();
    state.checkpoint = result.checkpoint;
    return result;
  };

  beforeEach(() => {
    state.cohort = ended;
  });

  it("reaches the plan behind fifty that must wait by the second run", async () => {
    state.waiting = new Set(ended.slice(0, 50).map((p) => p.id));
    const first = await tick();
    expect(first.plansWaiting).toBe(50);
    expect(state.opened).not.toContain("sub-51");
    expect(settled()).toEqual([]);

    state.opened = [];
    const second = await tick();
    expect(state.opened).toEqual(["sub-51"]);
    expect(settled()).toEqual(["sub-51"]);
    // The cohort ran out: the next run starts it over.
    expect(second.checkpoint).toBeNull();

    state.opened = [];
    await tick();
    expect(state.opened[0]).toBe("sub-01");
  });

  it("a run cut short by the deadline resumes after the last plan it handled", async () => {
    state.cohort = ended.slice(0, 5);
    state.budget = 2;
    const first = await tick();
    expect(state.opened).toEqual(["sub-01", "sub-02"]);
    expect(parsePlanCursor(first.checkpoint)).toEqual({
      stored: { at: ended[1].planEndsAt, id: "sub-02" },
      derived: null,
    });

    state.opened = [];
    state.budget = Infinity;
    await tick();
    expect(state.opened).toEqual(["sub-03", "sub-04", "sub-05"]);
  });

  it("starts over when nothing is left past the cursor", async () => {
    state.cohort = ended.slice(0, 3);
    state.checkpoint = JSON.stringify({
      stored: { at: ended[2].planEndsAt, id: "sub-03" },
      derived: null,
    });
    await tick();
    expect(state.opened).toEqual(["sub-01", "sub-02", "sub-03"]);
  });

  it("an unreadable checkpoint starts both cohorts over", () => {
    const start = { stored: null, derived: null };
    expect(parsePlanCursor("not json")).toEqual(start);
    expect(parsePlanCursor('{"stored":{"at":"soon","id":"x"}}')).toEqual(start);
  });
});
