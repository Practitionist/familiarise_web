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
  wrapperRows: [] as unknown[],
  undecided: 0,
};
const stamp = jest.fn(async () => ({ count: 1 }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentOccurrence: {
      // The due cohort first; a subscription arm then reads its wrapper's rows.
      findMany: async ({ where }: { where: { appointmentId?: string } }) =>
        where.appointmentId ? state.wrapperRows : state.due,
      findFirst: async () => state.madeUp,
      // Tentative rows are excluded by the query itself (where.isTentative).
      count: async ({ where }: { where: { isTentative?: boolean } }) =>
        where.isTentative === false ? state.undecided : 99,
      updateMany: (...a: unknown[]) => stamp(...(a as [])),
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
      findFirst: async () => ({ createdAt: new Date("2026-08-01T00:00:00Z") }),
    },
    refund: {
      // pay-a skipped the make-up already: its key is spent.
      findUnique: async ({ where }: { where: { dedupeKey: string } }) =>
        where.dedupeKey === "occ:occ-5:pay:pay-a"
          ? { status: "SUCCEEDED" }
          : null,
    },
  },
}));

import { settleCancelledSessions } from "@/scripts/appointments/settle-cancelled-sessions";

beforeEach(() => {
  jest.clearAllMocks();
  state.madeUp = null;
  state.due = [CLASS_SESSION];
  state.undecided = 0;
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

it("#1569 D4 — an unused subscription void is refunded at plan end, per session", async () => {
  const sub = {
    status: "APPROVED",
    sessionsTotal: 8,
    subscriptionPlan: { title: "Mentoring", totalSessions: 8 },
  };
  state.due = [
    {
      ...CLASS_SESSION,
      completionStatus: "VOIDED",
      appointment: { subscription: sub },
    },
  ];
  // 7 delivered + this void: one session of 8 was never had.
  state.wrapperRows = [
    ...Array.from({ length: 7 }, (_, i) => ({
      id: `d${i}`,
      completionStatus: "COMPLETED",
      seatsSettledAt: null,
    })),
    { id: "occ-5", completionStatus: "VOIDED", seatsSettledAt: null },
  ];
  await settleCancelledSessions();
  expect(refundBookingPayment).toHaveBeenCalledWith(
    expect.objectContaining({
      paymentId: "pay-b",
      amountPaise: 10_000,
      dedupeKey: "void-unused:occ-5:pay:pay-b",
    }),
  );
});

it("#1569 D4 — the refundable voids are the latest ones, whatever order the sweep takes them in", async () => {
  const sub = {
    status: "APPROVED",
    sessionsTotal: 8,
    subscriptionPlan: { title: "Mentoring", totalSessions: 8 },
  };
  const voided = (id: string) => ({
    ...CLASS_SESSION,
    id,
    completionStatus: "VOIDED",
    appointment: { subscription: sub },
  });
  // 6 delivered + 3 voids of 8: two sessions are owed, the earliest void was made up.
  state.wrapperRows = [
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `d${i}`,
      completionStatus: "COMPLETED",
      seatsSettledAt: null,
    })),
    ...["v1", "v2", "v3"].map((id) => ({
      id,
      completionStatus: "VOIDED",
      seatsSettledAt: null,
    })),
  ];
  state.due = [voided("v3"), voided("v1"), voided("v2")];
  await settleCancelledSessions();
  const keys = refundBookingPayment.mock.calls.map(
    (c) => (c as unknown as [{ dedupeKey: string }])[0].dedupeKey,
  );
  expect(keys.filter((k) => k.endsWith(":pay:pay-b"))).toEqual([
    "void-unused:v3:pay:pay-b",
    "void-unused:v2:pay:pay-b",
  ]);
});

it("#1569 D4 — plan-end void refunds wait while any session is undecided", async () => {
  const sub = {
    status: "APPROVED",
    sessionsTotal: 8,
    subscriptionPlan: { title: "M", totalSessions: 8 },
  };
  state.due = [
    {
      ...CLASS_SESSION,
      completionStatus: "VOIDED",
      appointment: { subscription: sub },
    },
  ];
  state.undecided = 1;
  const result = await settleCancelledSessions();
  expect(refundBookingPayment).not.toHaveBeenCalled();
  expect(result.stamped).toBe(0);
});
