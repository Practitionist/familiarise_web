/**
 * @jest-environment node
 */

/**
 * #1766 (PR-Z2) — a subscription's earnings tranches are delivery-enforced
 * escrow. The completion path stamps `holdUntil` on every tranche whose cycle
 * is now delivered in full and on nothing beyond it; a cancellation stamps
 * whatever is still unstamped so the value the refund leaves behind can pay
 * out, and the refund then consumes the newest tranches first.
 */

jest.mock("../../lib/novu/client", () => ({
  __esModule: true,
  isNovuConfigured: () => true,
  getNovuClient: () => {
    throw new Error("never sent in-tx");
  },
}));
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  settleSubscriptionCycle,
  stampTranchesOnCancel,
  unstampUndeliveredTranches,
} from "../../lib/booking/subscription-cycle";
import { allocateCycleClawback } from "../../lib/payments/payouts/earnings-reversal";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-03-30T10:00:00.000Z");
const HOLD_HOURS = 168;

function row(index: number, completionStatus: string) {
  const startsAt = new Date(NOW.getTime() - (12 - index) * 24 * HOUR);
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    completionStatus,
    isTentative: false,
    deletedAt: null,
  };
}

/** A 12-session plan at 4 per week: three tranches of 4. */
function wrapperWith(statuses: string[], sessionsRefunded = 0) {
  return {
    organizationId: null,
    payment: [{ id: "pay-1" }],
    subscription: {
      id: "sub-1",
      status: "APPROVED",
      sessionsTotal: 12,
      sessionsRefunded,
      schedulingPeriodStartsAt: new Date("2026-03-02T00:00:00.000Z"),
      schedulingTimezone: "UTC",
      requestedBy: { userId: "consultee-user" },
      subscriptionPlan: {
        title: "Intensive",
        totalSessions: 12,
        sessionsPerWeek: 4,
        durationInMonths: 3,
        consultantProfile: { user: { name: "Asha" } },
      },
    },
    occurrences: statuses.map((status, i) => row(i, status)),
  };
}

/** One payee; tenured unless `firstPaidAt` says otherwise (the new-expert hold). */
function makeTx(
  statuses: string[],
  firstPaidAt = new Date("2020-01-01"),
  sessionsRefunded = 0,
) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    appointment: {
      findUnique: jest
        .fn()
        .mockResolvedValue(wrapperWith(statuses, sessionsRefunded)),
    },
    consultantEarnings: {
      updateMany,
      findMany: jest.fn().mockResolvedValue([{ consultantProfileId: "cp-1" }]),
      findFirst: jest.fn().mockResolvedValue({ createdAt: firstPaidAt }),
      aggregate: jest.fn().mockResolvedValue({
        _sum: { consultantSharePaise: 9e9, refundedShareAmount: 0 },
      }),
    },
    notificationOutbox: {
      upsert: jest.fn().mockResolvedValue({
        id: "outbox-1",
        transactionId: "t",
        workflowId: "subscription-renewed",
        kind: "SINGLE",
        recipients: ["consultee-user"],
        payload: {},
        attempts: 0,
        status: "PENDING",
      }),
    },
    membership: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  return { tx, updateMany };
}

const completed = (n: number) => Array<string>(n).fill("COMPLETED");

function stampCall(updateMany: jest.Mock) {
  expect(updateMany).toHaveBeenCalledTimes(1);
  return updateMany.mock.calls[0][0] as {
    where: { cycleOrdinal: { lte: number }; holdUntil: null };
    data: { holdUntil: Date };
  };
}

it("the 4th completion stamps tranche 0 only, anchored on that session's end plus the hold", async () => {
  const { tx, updateMany } = makeTx(completed(4));
  await settleSubscriptionCycle(tx as never, {
    appointmentId: "apt-1",
    now: NOW,
  });

  const call = stampCall(updateMany);
  expect(call.where.cycleOrdinal).toEqual({ lte: 0 });
  expect(call.where.holdUntil).toBeNull();
  const fourthEnd = row(3, "COMPLETED").endsAt.getTime();
  expect(call.data.holdUntil).toEqual(
    new Date(Math.max(fourthEnd, NOW.getTime()) + HOLD_HOURS * HOUR),
  );
});

it("a new expert's tranche waits the extra new-expert days", async () => {
  const { tx, updateMany } = makeTx(completed(4), new Date());
  await settleSubscriptionCycle(tx as never, {
    appointmentId: "apt-1",
    now: NOW,
  });

  const fourthEnd = row(3, "COMPLETED").endsAt.getTime();
  expect(stampCall(updateMany).data.holdUntil).toEqual(
    new Date(
      Math.max(fourthEnd, NOW.getTime()) + HOLD_HOURS * HOUR + 3 * 24 * HOUR,
    ),
  );
});

it("the 8th completion stamps up to tranche 1; the 3rd stamps nothing", async () => {
  const eighth = makeTx(completed(8));
  await settleSubscriptionCycle(eighth.tx as never, {
    appointmentId: "apt-1",
    now: NOW,
  });
  expect(stampCall(eighth.updateMany).where.cycleOrdinal).toEqual({ lte: 1 });

  const third = makeTx(completed(3));
  await settleSubscriptionCycle(third.tx as never, {
    appointmentId: "apt-1",
    now: NOW,
  });
  expect(third.updateMany).not.toHaveBeenCalled();
});

it.each([
  [0, 1],
  [2, 2],
])(
  "10 completions with %i sessions refunded stamp up to tranche %i",
  async (sessionsRefunded, lastTranche) => {
    // 12 at 4 a week: refunding 2 leaves the buyer 10, so the 10th delivery
    // matures the part of tranche 2 the refund did not claw back.
    const { tx, updateMany } = makeTx(
      completed(10),
      new Date("2020-01-01"),
      sessionsRefunded,
    );
    await settleSubscriptionCycle(tx as never, {
      appointmentId: "apt-1",
      now: NOW,
    });
    expect(stampCall(updateMany).where.cycleOrdinal).toEqual({
      lte: lastTranche,
    });
  },
);

it("the final completion stamps the last tranche even though no bell is due", async () => {
  const { tx, updateMany } = makeTx(completed(12));
  const staged = await settleSubscriptionCycle(tx as never, {
    appointmentId: "apt-1",
    now: NOW,
  });
  expect(stampCall(updateMany).where.cycleOrdinal).toEqual({ lte: 2 });
  expect(staged).toEqual([]);
});

it("a void that leaves 7 of 8 delivered un-stamps every unreleased tranche above 0, and none on an ended plan", async () => {
  const { tx, updateMany } = makeTx([...completed(7), "VOIDED"]);
  await unstampUndeliveredTranches(tx as never, {
    appointmentId: "apt-1",
    now: NOW,
  });
  // READY, BATCHED and PAID are outside the status filter, so a released tranche keeps its date.
  expect(updateMany.mock.calls).toEqual([
    [
      {
        where: {
          paymentId: { in: ["pay-1"] },
          cycleOrdinal: { gt: 0 },
          holdUntil: { not: null },
          OR: [
            { status: { in: ["PENDING", "PENDING_TRUST"] } },
            {
              status: "HELD",
              preHoldStatus: { in: ["PENDING", "PENDING_TRUST"] },
            },
          ],
        },
        data: { holdUntil: null },
      },
    ],
  ]);

  const ended = makeTx([...completed(7), "VOIDED"]);
  const wrapper = wrapperWith([...completed(7), "VOIDED"]);
  ended.tx.appointment.findUnique.mockResolvedValue({
    ...wrapper,
    subscription: { ...wrapper.subscription, status: "CANCELLED" },
  });
  await unstampUndeliveredTranches(ended.tx as never, {
    appointmentId: "apt-1",
    now: NOW,
  });
  expect(ended.updateMany).not.toHaveBeenCalled();
});

it("cancel after 6: tranche 0 matured and untouched, tranche 1 keeps a stamped remainder, tranche 2 is consumed whole", async () => {
  // Delivered: 6 of 12. The completion path stamped tranche 0 at the 4th;
  // tranches 1 and 2 are still NULL when the buyer cancels.
  const { tx, updateMany } = makeTx(completed(6));
  await stampTranchesOnCancel(tx as never, { paymentId: "pay-1", now: NOW });
  const cancel = updateMany.mock.calls[0][0] as {
    where: Record<string, unknown>;
    data: { holdUntil: Date };
  };
  expect(cancel.where).toEqual({
    paymentId: "pay-1",
    consultantProfileId: "cp-1",
    cycleOrdinal: { not: null },
    holdUntil: null,
    OR: [
      { status: { in: ["PENDING", "PENDING_TRUST"] } },
      { status: "HELD", preHoldStatus: { in: ["PENDING", "PENDING_TRUST"] } },
    ],
  });
  expect(cancel.data.holdUntil).toEqual(
    new Date(NOW.getTime() + HOLD_HOURS * HOUR),
  );

  // The refund returns the 6 undelivered sessions: half the pool. The newest
  // tranche goes first, so tranche 2 (4 sessions) is consumed whole and
  // tranche 1 gives up 2 of its 4; tranche 0, delivered in full, is untouched.
  const pool = 12_000;
  const tranches = [0, 1, 2].map((k) => ({
    id: `t${k}`,
    cycleOrdinal: k,
    consultantSharePaise: pool / 3,
    refundedShareAmount: 0,
    status: "PENDING",
    holdUntil: cancel.data.holdUntil,
  }));
  expect(allocateCycleClawback(tranches, pool / 2)).toEqual([
    { id: "t2", absorbPaise: 4_000 },
    { id: "t1", absorbPaise: 2_000 },
  ]);
});
