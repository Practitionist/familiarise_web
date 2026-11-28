/**
 * @jest-environment node
 */

/**
 * #1780 row 4 (E-4, E-3b) — the day-14 sweep refunds each seat that held a
 * cancelled, never-made-up session one unit under `occ:<occ>:pay:<pay>`: a
 * seat that already skipped the make-up carries the key and is not refunded
 * again; a made-up session is only stamped.
 */

const refundBookingPayment = jest.fn(async () => ({
  refundId: "rf",
  amountRefundedPaise: 10_000,
  rail: "GATEWAY",
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => refundBookingPayment(...(a as [])),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_k: string, _o: unknown, fn: () => unknown) => fn(),
  readJobCheckpoint: async () => null,
}));
jest.mock("../../lib/novu/outbox", () => ({ stageTrigger: jest.fn() }));
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: (_id: string, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/booking/class-series", () => ({
  seatLedger: async () => ({ unitPaise: BigInt(10_000) }),
}));

const CLASS_SESSION = {
  id: "occ-5",
  appointmentId: "apt-1",
  ordinal: 5,
  startsAt: new Date("2026-09-01T10:00:00Z"),
  completionStatus: "CANCELLED",
  appointment: { class: { classPlan: { title: "Python" } } },
};
const state = {
  madeUp: null as { id: string } | null,
  due: [CLASS_SESSION] as unknown[],
  seatStatus: undefined as string | undefined,
  spent: new Set<string>(),
  seatPaymentId: null as string | null,
  events: [] as { correlationId: string; context: unknown }[],
  /** Who cancelled the session, as its history row records it. */
  cancelActor: null as string | null,
};
const stamp = jest.fn(async () => ({ count: 1 }));
/** The where of every occurrence read, in order; the first is the 14-day cohort. */
const occurrenceReads: unknown[] = [];
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentOccurrence: {
      findMany: async (args: { where?: unknown } = {}) => {
        occurrenceReads.push(args.where);
        return state.due;
      },
      findFirst: async () => state.madeUp,
      // Subscription voids of ended plans are a separate, money-free stamp.
      updateMany: async (args: { where: { appointment?: unknown } }) =>
        args.where.appointment ? { count: 0 } : stamp(),
    },
    payment: {
      findMany: async () =>
        ["pay-a", "pay-b"].map((id) => ({
          id,
          amount: 80_000,
          currency: "INR",
          userId: `u-${id}`,
          createdAt: new Date("2026-08-01T00:00:00Z"),
        })),
      // Nothing refunded yet: the whole seat is still refundable.
      findUnique: async () => ({ refunds: [], disputes: [] }),
    },
    appointmentParticipant: {
      // The seat row answers only its own payment's lookup (or any, when unlinked).
      findFirst: async ({
        where,
      }: {
        where: { OR?: { paymentId: string | null }[] };
      }) =>
        state.seatPaymentId &&
        !where.OR?.some((o) => o.paymentId === state.seatPaymentId)
          ? null
          : {
              id: "seat-1",
              status: state.seatStatus,
              createdAt: new Date("2026-08-01T00:00:00Z"),
            },
    },
    bookingStatusHistory: {
      findFirst: async () =>
        state.cancelActor ? { actorUserId: state.cancelActor } : null,
    },
    // No plan has ended in these scenarios; plan-end settlement has its own suite.
    subscription: { findMany: async () => [] },
    systemEvent: {
      findFirst: async ({ where }: { where: { correlationId: string } }) =>
        state.events.find((e) => e.correlationId === where.correlationId) ??
        null,
      create: async ({
        data,
      }: {
        data: { correlationId: string; context: unknown };
      }) => state.events.push(data),
    },
    refund: {
      // pay-a skipped the make-up already: its key is spent.
      findUnique: async ({ where }: { where: { dedupeKey: string } }) =>
        state.spent.has(where.dedupeKey) ? { status: "SUCCEEDED" } : null,
    },
  },
}));

import { settleCancelledSessions } from "@/scripts/appointments/settle-cancelled-sessions";
import { matchesWhere, type Where } from "../fixtures/mem-db";

beforeEach(() => {
  jest.clearAllMocks();
  occurrenceReads.length = 0;
  state.madeUp = null;
  state.due = [CLASS_SESSION];
  state.seatStatus = undefined;
  state.seatPaymentId = null;
  state.spent = new Set(["occ:occ-5:pay:pay-a"]);
  state.events = [];
  state.cancelActor = null;
});

it("#1834 — a paid seat still HELD goes to the ops queue once, never refunded", async () => {
  state.seatStatus = "HELD";
  // The seat is funded by pay-b; pay-a is an older order and is not this seat's.
  state.seatPaymentId = "pay-b";
  await settleCancelledSessions();
  await settleCancelledSessions();
  expect(refundBookingPayment).not.toHaveBeenCalled();
  expect(state.events.map((e) => e.correlationId)).toEqual([
    "held-paid-seat:occ-5:pay-b",
  ]);
  expect(state.events[0].context).toMatchObject({
    occurrenceId: "occ-5",
    paymentId: "pay-b",
    participantId: "seat-1",
    unitPaise: 10_000,
  });
});

it("refunds only the seat whose key is not spent, then stamps the session", async () => {
  const result = await settleCancelledSessions();
  expect(refundBookingPayment).toHaveBeenCalledTimes(1);
  expect(refundBookingPayment).toHaveBeenCalledWith(
    expect.objectContaining({
      paymentId: "pay-b",
      amountPaise: 10_000,
      dedupeKey: "occ:occ-5:pay:pay-b",
      keepSeat: true,
    }),
  );
  expect(result.stamped).toBe(1);
});

it("a made-up session is stamped with zero refunds", async () => {
  state.madeUp = { id: "occ-make-up" };
  const result = await settleCancelledSessions();
  expect(refundBookingPayment).not.toHaveBeenCalled();
  expect(result.stamped).toBe(1);
});

it("#1569 — a voided class session: the skipped seat is not paid twice", async () => {
  state.due = [{ ...CLASS_SESSION, completionStatus: "VOIDED" }];
  await settleCancelledSessions();
  expect(refundBookingPayment).toHaveBeenCalledTimes(1);
  expect(refundBookingPayment).toHaveBeenCalledWith(
    expect.objectContaining({
      dedupeKey: "occ:occ-5:pay:pay-b",
      reason: "SESSION_VOIDED_NOT_MADE_UP",
    }),
  );
});

describe("the delayed refund notice of a host-cancelled session", () => {
  const stagedPayload = () => {
    const { stageTrigger } = jest.requireMock("../../lib/novu/outbox") as {
      stageTrigger: jest.Mock;
    };
    return stageTrigger.mock.calls[0][0].payload as Record<string, unknown>;
  };

  it("is required for a seat holder someone else cancelled it for", async () => {
    state.cancelActor = "u-host";
    await settleCancelledSessions();
    expect(stagedPayload().requiredNotice).toBe("CLASS_SESSION_REFUNDED");
  });

  it("stays switchable for the seat holder who cancelled it themself", async () => {
    state.cancelActor = "u-pay-b";
    await settleCancelledSessions();
    expect(stagedPayload().requiredNotice).toBeUndefined();
  });
});

it("leaves an unconfirmed negative void out of the 14-day cohort, counts a confirmed one's 14 days from its confirmation and an outage void's from the void", async () => {
  await settleCancelledSessions();
  const cohort = occurrenceReads[0] as Where;
  const voided = (over: Record<string, unknown>) => ({
    seatsSettledAt: null,
    deletedAt: null,
    completionStatus: "VOIDED",
    voidedAt: new Date(Date.now() - 15 * 86_400_000),
    outcomeConfirmedAt: null,
    appointment: { classId: "cls-1", webinarId: null, consultationId: null },
    ...over,
  });
  // Weak, disputed or not yet judged: the window-close pass never stamped it.
  expect(matchesWhere(voided({ outcome: "HOST_ABSENT" }), cohort)).toBe(false);
  expect(matchesWhere(voided({ outcome: "CUT_SHORT" }), cohort)).toBe(false);
  // Confirmed 14 days ago or more, by the pass or by ops writing it: the make-up window ran from that confirmation.
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
  expect(
    matchesWhere(
      voided({ outcome: "CUT_SHORT", outcomeConfirmedAt: daysAgo(15) }),
      cohort,
    ),
  ).toBe(true);
  // Voided 20 days ago and confirmed yesterday: 13 days of the make-up window are left.
  expect(
    matchesWhere(
      voided({
        outcome: "CUT_SHORT",
        voidedAt: daysAgo(20),
        outcomeConfirmedAt: daysAgo(1),
      }),
      cohort,
    ),
  ).toBe(false);
  // An outage attributes nothing to anyone and needs no confirmation: 14 days from the void.
  expect(matchesWhere(voided({ outcome: "PLATFORM_OUTAGE" }), cohort)).toBe(
    true,
  );
  expect(
    matchesWhere(
      voided({ outcome: "PLATFORM_OUTAGE", voidedAt: daysAgo(13) }),
      cohort,
    ),
  ).toBe(false);
  expect(matchesWhere(voided({ outcome: null }), cohort)).toBe(true);
});
