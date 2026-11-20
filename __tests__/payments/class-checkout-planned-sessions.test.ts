/**
 * @jest-environment node
 */

/**
 * #1554 — a class's "fully scheduled" gate and its engagement meter count
 * PLANNED sessions: a RESCHEDULED row is a session awaiting its new time, not
 * a missing one. Excluding it blocked every enrollment for the length of an
 * open reschedule and under-counted the engagements the seat buys.
 *
 * Mocks mirror consultation-occurrence-parity.test.ts: everything lib/payments/checkout
 * touches at module scope is stubbed so the one exported handler can run
 * against a hand-built transaction.
 */

jest.mock("../../lib/db/serializable-retry", () => ({
  __esModule: true,
  withSerializableRetry: (fn: () => unknown) => fn(),
}));
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  startSpan: (_o: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  __esModule: true,
  refundPayment: jest.fn(),
}));
jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  createEarningsFromPayment: jest.fn(),
  reverseEarningsForPayment: jest.fn(),
}));
jest.mock("../../lib/email", () => ({
  __esModule: true,
  sendPaymentSuccessEmail: jest.fn(),
  sendPaymentFailedEmail: jest.fn(),
}));
jest.mock("../../lib/novu", () => ({
  __esModule: true,
  notifyPaymentSuccess: jest.fn(),
  notifyPaymentFailed: jest.fn(),
  notifyAppointmentBooked: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  __esModule: true,
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  __esModule: true,
  addUserToEventChannel: jest.fn(),
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  __esModule: true,
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  __esModule: true,
  streamLogger: { info: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/enterprise/system-events", () => {
  return {
    __esModule: true,
    recordSystemError: () => Promise.resolve(),
    recordSystemErrorSafe: () => Promise.resolve(),
  };
});
jest.mock("../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../lib/payments/utils/slot-validation", () => ({
  __esModule: true,
  validateSlotTiming: jest.fn().mockReturnValue(null),
}));
jest.mock("../../lib/events/capacity", () => ({
  __esModule: true,
  getWebinarCapacity: jest.fn(),
  getClassCapacity: jest.fn().mockReturnValue({ isFull: false }),
}));

import { handleClassCheckout } from "../../lib/payments/checkout/handlers/class";
import type { Tx } from "../../lib/prisma";
import type { CheckoutInput } from "../../schemas/checkout";

const HOUR = 60 * 60 * 1000;
const future = (days: number) => new Date(Date.now() + days * 24 * HOUR);

function occurrence(
  id: string,
  startsAt: Date,
  completionStatus = "SCHEDULED",
) {
  return {
    id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    isTentative: completionStatus === "RESCHEDULED",
    completionStatus,
    deletedAt: null,
  };
}

/**
 * A four-session class. The class read carries `occurrences` (it leaves
 * cancelled rows out); the occurrence reads see `stored`, by their status filter.
 */
function txWith(
  occurrences: ReturnType<typeof occurrence>[],
  plan: {
    price?: number;
    totalSessions?: number;
    lateJoinUntilSession?: number | null;
  } = {},
  stored: ReturnType<typeof occurrence>[] = occurrences,
) {
  const createMany = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    class: {
      findUnique: jest.fn().mockResolvedValue({
        id: "class-1",
        classPlan: {
          price: 100_000,
          totalSessions: 4,
          lateJoinUntilSession: null,
          ...plan,
          consultantProfile: { userId: "consultant-user" },
        },
        appointment: { id: "appt-class", occurrences, participants: [] },
      }),
    },
    appointmentOccurrence: {
      findMany: jest.fn(
        async (args: { where?: { completionStatus?: string } }) =>
          stored.filter(
            (o) =>
              !args.where?.completionStatus ||
              o.completionStatus === args.where.completionStatus,
          ),
      ),
    },
    appointmentParticipant: {
      createMany,
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  return tx as unknown as Tx;
}

const PLANNED = [
  occurrence("s1", future(7)),
  occurrence("s2", future(14), "RESCHEDULED"),
  occurrence("s3", future(21)),
  occurrence("s4", future(28)),
];

it("counts a RESCHEDULED session as planned: the gate opens and the meter says four", async () => {
  const tx = txWith(PLANNED);
  const result = await handleClassCheckout(
    tx,
    { eventId: "class-1" } as unknown as CheckoutInput,
    "buyer-1",
    false,
  );

  expect(result.engagementsConsumed).toBe(4);
  expect(result.slotsLinked).toBe(4);
  // One seat on the class wrapper, held until the payment captures.
  expect(
    (tx.appointmentParticipant.createMany as jest.Mock).mock.calls[0][0].data,
  ).toEqual([
    expect.objectContaining({
      appointmentId: "appt-class",
      userId: "buyer-1",
      role: "CONSULTEE",
      status: "HELD",
    }),
  ]);
  // And the read itself keeps the released row: only a cancelled or deleted
  // session is out of the plan.
  const args = (tx.class.findUnique as jest.Mock).mock.calls[0][0];
  expect(args.include.appointment.include.occurrences.where).toEqual({
    deletedAt: null,
    completionStatus: { not: "CANCELLED" },
  });
});

it("still refuses a class that is genuinely short of sessions", async () => {
  await expect(
    handleClassCheckout(
      txWith(PLANNED.slice(0, 3)),
      { eventId: "class-1" } as unknown as CheckoutInput,
      "buyer-1",
      false,
    ),
  ).rejects.toThrow(/not fully scheduled yet \(3 of 4 sessions\)/);
});

describe("a session the host cancelled, inside its make-up window", () => {
  const DAY = 24 * HOUR;
  // Sessions 1, 3 and 4 are live; session 2 was cancelled by the host.
  const live = [
    { ...occurrence("s1", future(7)), ordinal: 1 },
    { ...occurrence("s3", future(21)), ordinal: 3 },
    { ...occurrence("s4", future(28)), ordinal: 4 },
  ];
  const cancelled = (daysAgo: number) => ({
    ...occurrence("s2", future(14), "CANCELLED"),
    ordinal: 2,
    hostCancelledAt: new Date(Date.now() - daysAgo * DAY),
  });

  const txWithCancelled = (daysAgo: number) =>
    txWith(live, {}, [...live, cancelled(daysAgo)]);
  const buy = (tx: Tx) =>
    handleClassCheckout(
      tx,
      { eventId: "class-1" } as unknown as CheckoutInput,
      "buyer-1",
      false,
    );

  it("counts as planned: the seat is sold for all four sessions", async () => {
    const result = await buy(txWithCancelled(1));
    expect(result.sessionsPurchased).toBe(4);
    expect(result.amount).toBe(100_000);
  });

  it("is refused again once the make-up window has closed", async () => {
    await expect(buy(txWithCancelled(15))).rejects.toThrow(
      /not fully scheduled yet \(3 of 4 sessions\)/,
    );
  });
});

describe("#1819 — late join", () => {
  // Eight weekly sessions; the first `started` have already begun.
  const eight = (started: number) =>
    Array.from({ length: 8 }, (_, i) => ({
      ...occurrence(`s${i + 1}`, future(7 * (i + 1 - started))),
      ordinal: i + 1,
    }));
  const buy = (tx: Tx, quoted: number | null = null) =>
    handleClassCheckout(
      tx,
      { eventId: "class-1" } as unknown as CheckoutInput,
      "buyer-1",
      false,
      quoted,
    );
  const stamped = (tx: Tx) =>
    (tx.appointmentParticipant.updateMany as jest.Mock).mock.calls.at(-1)[0]
      .data;

  it("prices an on-time join in full and stamps every session", async () => {
    const tx = txWith(eight(0), { price: 99_999, totalSessions: 8 });
    expect((await buy(tx)).amount).toBe(99_999);
    expect(stamped(tx).sessionsPurchased).toBe(8);
  });

  it("prices a join before session 5 of 8 at 4/8, floored in the buyer's favour", async () => {
    const tx = txWith(eight(4), {
      price: 99_999,
      totalSessions: 8,
      lateJoinUntilSession: 6,
    });
    expect((await buy(tx, 4)).amount).toBe(49_999);
    expect(stamped(tx).sessionsPurchased).toBe(4);
  });

  it("meters a late joiner for the sessions bought, not the whole batch", async () => {
    const tx = txWith(eight(4), {
      price: 99_999,
      totalSessions: 8,
      lateJoinUntilSession: 6,
    });
    const result = await buy(tx, 4);
    expect(result.engagementsConsumed).toBe(4);
    expect(result.engagementIds).toEqual(["s5", "s6", "s7", "s8"]);
  });

  it("meters a rescheduled session once, on its replacement row", async () => {
    const rows = eight(4);
    // Released before session 5 starts, so it sorts ahead of it by time.
    const tombstone = {
      ...occurrence(
        "s6-old",
        new Date(rows[4].startsAt.getTime() - 1),
        "RESCHEDULED",
      ),
      ordinal: 6,
    };
    const tx = txWith([...rows.slice(0, 4), tombstone, ...rows.slice(4)], {
      totalSessions: 8,
      lateJoinUntilSession: 6,
    });
    const result = await buy(tx, 4);
    expect(result.engagementIds).toEqual(["s5", "s6", "s7", "s8"]);
  });

  it("closes enrolment once session 1 starts when the host set no cutoff", async () => {
    const tx = txWith(eight(1), { totalSessions: 8 });
    await expect(buy(tx)).rejects.toMatchObject({ code: "ENROLMENT_CLOSED" });
  });

  it("refuses a stale quote when a session started after it was priced", async () => {
    const tx = txWith(eight(4), { totalSessions: 8, lateJoinUntilSession: 6 });
    await expect(buy(tx, 5)).rejects.toMatchObject({
      code: "CLASS_PRICE_CHANGED",
    });
  });
});
