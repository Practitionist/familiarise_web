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

const state = { madeUp: null as { id: string } | null };
const stamp = jest.fn(async () => ({ count: 1 }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentOccurrence: {
      findMany: async () => [
        {
          id: "occ-5",
          appointmentId: "apt-1",
          ordinal: 5,
          startsAt: new Date("2026-09-01T10:00:00Z"),
          appointment: { class: { classPlan: { title: "Python" } } },
        },
      ],
      findFirst: async () => state.madeUp,
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
