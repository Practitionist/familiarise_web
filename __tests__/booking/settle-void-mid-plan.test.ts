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
};
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
      // The stored-end arm asks for planEndsAt <= now, the derived arm for null.
      findMany: async ({ where }: { where: { planEndsAt: unknown } }) =>
        (where.planEndsAt === null) === (state.plan.planEndsAt === null)
          ? [state.plan]
          : [],
      findUnique: async () => settleRead(state.reread ?? state.plan),
      updateMany: (...a: unknown[]) => subscriptionUpdateMany(...a),
    },
    rescheduleRequest: { findFirst: async () => null },
    payment: {
      findMany: async () => [
        {
          id: "pay-1",
          amount: 120_000,
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
    systemEvent: { findFirst: async () => null, create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { __esModule: true, default: db };
});

import { settleCancelledSessions } from "@/scripts/appointments/settle-cancelled-sessions";

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

it("settles, without money, the voids of plans that ended another way", async () => {
  await settleCancelledSessions();
  expect(occurrenceUpdateMany).toHaveBeenCalledWith({
    where: {
      completionStatus: "VOIDED",
      seatsSettledAt: null,
      deletedAt: null,
      appointment: {
        subscription: {
          status: { in: ["CANCELLED", "EXPIRED", "REJECTED", "COMPLETED"] },
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
